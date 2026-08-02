// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The extension side: the only place that holds the folder grant and the only
// place that writes.
//
// MEASURED (docs/DECISIONS.md, 2026-08-02): one `showDirectoryPicker` grant
// survives IndexedDB and a reload — still `granted` with no gesture, and
// re-grantable with one click when it lapses — and covers files INSIDE the
// folder that were never picked. That is what lets a deck opened by
// double-clicking be written without a destination prompt, which no web page
// can do for itself.
//
// THE MATCHING PROBLEM, and why it is not solved perfectly. A page gives us
// `/Users/…/Decks/Q3.bento.html`; a `FileSystemDirectoryHandle` knows its own
// NAME but not its path, and there is no API to ask. So the two cannot be
// compared directly. This resolves it by searching the granted tree for a file
// of that name and requiring EXACTLY ONE match: unambiguous in the ordinary
// case, and when it is ambiguous the answer is to decline and let the native
// picker handle it. Declining costs a prompt; guessing costs somebody's file.

const DB = 'bento-tray'
const STORE = 'grant'

const open = () => new Promise((res, rej) => {
  const r = indexedDB.open(DB, 1)
  r.onupgradeneeded = () => r.result.createObjectStore(STORE)
  r.onsuccess = () => res(r.result)
  r.onerror = () => rej(r.error)
})

async function readGrant() {
  const d = await open()
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, 'readonly')
    const q = t.objectStore(STORE).get('dir')
    q.onsuccess = () => res(q.result ?? null)
    q.onerror = () => rej(q.error)
  })
}

/** Every file of this name in the granted tree. Depth-limited: a Decks folder
 *  is not a filesystem, and an unbounded walk on a mistakenly-granted home
 *  directory would hang the save the user is waiting on. */
async function findByName(dir, name, depth = 0, found = []) {
  if (depth > 4 || found.length > 1) return found
  for await (const [entryName, handle] of dir.entries()) {
    if (handle.kind === 'file' && entryName === name) found.push(handle)
    else if (handle.kind === 'directory' && !entryName.startsWith('.')) {
      await findByName(handle, name, depth + 1, found)
    }
    if (found.length > 1) break // ambiguous is already an answer
  }
  return found
}

/** token → file handle, for the life of this service-worker instance. */
const claims = new Map()

async function claim(path) {
  const dir = await readGrant()
  if (!dir) return { ok: false, reason: 'no folder granted' }
  // queryPermission only — never prompt from here. A service worker has no
  // user gesture, so a request would be refused, and a save is the wrong
  // moment to discover that. The options page is where granting happens.
  const perm = await dir.queryPermission({ mode: 'readwrite' })
  if (perm !== 'granted') return { ok: false, reason: 'folder grant needs renewing' }

  const name = decodeURIComponent(path.split('/').pop() || '')
  if (!name) return { ok: false, reason: 'no file name' }
  const hits = await findByName(dir, name)
  if (hits.length !== 1) {
    return { ok: false, reason: hits.length ? `${name} is ambiguous in the granted folder` : 'not in the granted folder' }
  }
  const token = crypto.randomUUID()
  claims.set(token, hits[0])
  return { ok: true, token, name }
}

async function write({ token, text }) {
  const handle = claims.get(token)
  if (!handle) return { ok: false, reason: 'stale claim' }
  try {
    // The open question this scaffold cannot settle without being loaded:
    // whether an MV3 service worker may createWritable() on a stored handle,
    // or whether the write must move to an offscreen document. Kept as ONE
    // call so that answer changes this function and nothing else.
    const w = await handle.createWritable()
    await w.write(text)
    await w.close()
    return { ok: true, bytes: text.length }
  } catch (e) {
    return { ok: false, reason: `${e.name}: ${e.message}` }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const run = msg?.op === 'claim' ? claim(msg.payload?.path)
    : msg?.op === 'write' ? write(msg.payload ?? {})
    : Promise.resolve({ ok: false, reason: 'unknown op' })
  run.then(sendResponse, (e) => sendResponse({ ok: false, reason: String(e?.message || e) }))
  return true // async response
})
