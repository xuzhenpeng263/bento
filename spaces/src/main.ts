// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Boot sequence for bento/spaces. Order matters: configure the app, then
// capture the pristine document BEFORE any DOM mutation — the captured copy is
// what gets re-serialized on save.

import './styles.css'
import { configureApp, appConfig } from '../../kernel/src/app.ts'
import {
  capturePristine, readEmbeddedDoc, serializeFile, serializeAuto,
  saveFile, parseEnvelope, canWriteInPlace, decryptEnvelope, setEncryptionPassword,
  isEncryptionActive,
} from '../../kernel/src/save.ts'
import { putRecovery, getRecovery, clearRecovery, pruneOld } from '../../kernel/src/autosave.ts'
import { APP_VERSION } from '../../kernel/src/update.ts'
import { t, applyDirection } from './i18n'
import { parseDoc, docContentKey, uid, type SpacesDoc, type ParseResult } from './model'
import { starterDoc } from './starter'
import { Store } from './store'
import { Editor } from './editor'
import { downloadMarkdown } from './about'

configureApp({
  appId: 'bento-spaces',
  appName: 'bento/spaces',
  manifestUrl: 'https://bento.page/releases/spaces/manifest.json',
})

capturePristine()
applyDirection()

const embedded = readEmbeddedDoc()

const envelope = embedded ? parseEnvelope(embedded) : null

if (envelope) {
  void passwordGate()
} else {
  const res = parseDoc(embedded ?? '')
  if (res.ok) {
    if (!res.doc.docId) res.doc.docId = uid('doc')
    boot(res.doc, res.repaired, res.frozen)
  } else if (res.err === 'empty') {
    // THE ONLY path to the starter. Anything else that failed to parse is
    // someone's data, and replacing it with an empty space would be a loss the
    // first ⌘S makes permanent.
    const doc = starterDoc()
    doc.docId = uid('doc')
    boot(doc, [], undefined)
  } else {
    refuse(res)
  }
}

/**
 * An encrypted space: ask, then boot.
 *
 * This MUST exist for as long as the About dialog can set a password —
 * otherwise encrypting a space locks its author out of it permanently, which
 * is the worst bug this app could have. The password is held in memory so
 * every later save stays encrypted.
 */
async function passwordGate(): Promise<void> {
  document.getElementById('bento-splash')?.remove()
  const wrap = document.createElement('div')
  wrap.className = 'sp-gate'
  const card = document.createElement('div')
  card.className = 'sp-gate-card'
  card.innerHTML = `<h1>${t('This space is locked')}</h1>` +
    `<p>${t('Enter the password to open it.')}</p>`
  const input = document.createElement('input')
  input.type = 'password'
  input.className = 'sp-find'
  input.autocomplete = 'current-password'
  const go = document.createElement('button')
  go.className = 'sp-btn sp-primary'
  go.textContent = t('Unlock')
  const err = document.createElement('p')
  err.className = 'sp-note'
  card.append(input, go, err)
  wrap.append(card)
  document.body.append(wrap)
  input.focus()

  const tryUnlock = async () => {
    const pass = input.value
    if (!pass) return
    go.disabled = true
    const json = await decryptEnvelope(envelope!, pass)
    go.disabled = false
    if (json === null) { err.textContent = t('Wrong password — try again'); input.select(); return }
    const res = parseDoc(json)
    if (!res.ok) { err.textContent = t('Unlocked, but the document inside could not be read.'); return }
    // held in memory so ⌘S and autosave keep writing encrypted
    setEncryptionPassword(pass)
    wrap.remove()
    if (!res.doc.docId) res.doc.docId = uid('doc')
    boot(res.doc, res.repaired, res.frozen)
  }
  go.addEventListener('click', () => { void tryUnlock() })
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void tryUnlock() })
}

/**
 * A document we cannot read is NOT a reason to show an empty one.
 *
 * No editor, no autosave, and two ways out that do not require us to have
 * understood the file: keep the bytes exactly as they are, or take the JSON
 * somewhere else.
 */
function refuse(res: Extract<ParseResult, { ok: false }>): void {
  const detail = 'detail' in res ? res.detail : ''
  const what = res.err === 'format'
    ? t('This is not a bento/spaces document — {detail}.', { detail })
    : res.err === 'json'
      ? t('The document block is not valid JSON — {detail}.', { detail })
      : t('The document block is not shaped like a space — {detail}.', { detail })

  gate(t('This file could not be opened'), what, [
    [t('Save an untouched copy…'), () => {
      // the bytes as they are, NOT a re-serialization: we did not understand
      // this document, so we must not rewrite it
      const html = `<!DOCTYPE html>\n${document.documentElement.outerHTML}`
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
      a.download = 'untouched-copy.bento.html'
      a.click()
    }],
    [t('Copy the document JSON'), () => { void navigator.clipboard?.writeText(embedded ?? '') }],
  ])

  const pre = document.createElement('pre')
  pre.className = 'sp-gate-raw'
  pre.textContent = (embedded ?? '').slice(0, 400)
  document.querySelector('.sp-gate-card')?.append(pre)
}

function gate(title: string, body: string, actions: Array<[string, () => void]>): void {
  document.getElementById('bento-splash')?.remove()
  const wrap = document.createElement('div')
  wrap.className = 'sp-gate'
  const card = document.createElement('div')
  card.className = 'sp-gate-card'
  const h = document.createElement('h1')
  h.textContent = title
  const p = document.createElement('p')
  p.textContent = body
  card.append(h, p)
  for (const [label, fn] of actions) {
    const b = document.createElement('button')
    b.className = 'sp-btn sp-primary'
    b.textContent = label
    b.addEventListener('click', fn)
    card.append(b)
  }
  wrap.append(card)
  document.body.append(wrap)
}

function boot(doc: SpacesDoc, repaired: string[], frozen?: 'policy' | 'version'): void {
  document.title = `${doc.title} — ${appConfig().appName}`
  document.getElementById('bento-splash')?.remove()

  const store = new Store(doc)
  if (frozen) store.readOnly = true
  const editor = new Editor(document.getElementById('app')!, store)

  if (frozen) {
    banner(frozen === 'version'
      ? t('This file was written by a newer version of bento/spaces. It is open read-only so nothing is lost.')
      : t('This file declares rules this build does not know. It is open read-only so nothing is lost.'))
  }
  if (repaired.length) {
    banner(t('{n} duplicate or missing id(s) were repaired so links and pages resolve.', { n: repaired.length }))
  }

  editor.onSave = () => { void doSave() }
  editor.onSaveAs = (suffix: string) => {
    if (suffix === '__markdown') { downloadMarkdown(store); return }
    store.endRun()
    // forcePicker = "Save a copy…": it always asks where, and the kernel keeps
    // the in-place handle pointed at the working file, so a later ⌘S does not
    // start overwriting the copy
    void saveFile(store.doc, true).then((res) => {
      if (res === 'saved') editor.status(t('Copy saved'))
    })
  }
  async function doSave(): Promise<void> {
    store.endRun()
    editor.status(t('Saving…'))
    const res = await saveFile(store.doc)
    if (res === 'saved') {
      void clearRecovery(store.doc.docId)
      // "Saved" is doing real work here: on a browser without file-system
      // access this was a NEW download, and saying so is the difference
      // between understanding that and losing track of which copy is current
      editor.status(canWriteInPlace() ? t('Saved') : t('Saved a new copy'))
    } else {
      editor.status('')
    }
  }

  // A recovery snapshot is the ONLY backstop on browsers with no file-system
  // access — which is every browser on iOS.
  //
  // NEVER for an encrypted space. The snapshot is the document as plain JSON,
  // so writing one puts in IndexedDB exactly what the password exists to keep
  // off the disk — and it would do it every few seconds, for the one author who
  // demonstrably cares. The kernel's putRecovery does not guard this; the
  // caller must (slides has the same contract).
  let timer: ReturnType<typeof setTimeout> | undefined
  store.on('doc', () => {
    clearTimeout(timer)
    if (isEncryptionActive()) return
    timer = setTimeout(() => { void putRecovery(store.doc) }, 2500)
  })
  void pruneOld()
  void offerRecovery(doc, store, editor)

  // ---- the AI round-trip (PLATFORM §7) -----------------------------------
  ;(window as any).bento = {
    format: doc.format,
    get doc() { return store.doc },
    get readonly() { return store.readOnly },
    serialize: () => serializeFile(store.doc),
    serializeAuto: () => serializeAuto(store.doc),
    undo: () => { store.undo(); editor.repaint() },
    redo: () => { store.redo(); editor.repaint() },
    updates: { version: APP_VERSION },
    /** every page, flat — the shape an agent wants before it reads anything */
    pages: () => store.doc.pages.map((p) => ({
      id: p.id, title: p.title, parent: p.parent, archived: !!p.archived, blocks: p.blocks.length,
    })),
    getPage: (id: string) => store.doc.pages.find((p) => p.id === id) ?? null,
    search: (q: string) => {
      const needle = String(q).toLowerCase()
      const out: Array<{ pageId: string; title: string; blockId: string }> = []
      for (const p of store.doc.pages) {
        for (const b of p.blocks) {
          const text = (b.html ?? '').replace(/<[^>]+>/g, '')
          if (text.toLowerCase().includes(needle)) out.push({ pageId: p.id, title: p.title, blockId: b.id })
        }
      }
      return out
    },
    /**
     * ONE undoable step. Without this an agent appending a paragraph has to
     * rewrite and reparse the whole space through loadDoc — clobbering
     * concurrent edits and flattening undo to a single entry.
     */
    insertBlocks: (pageId: string, afterId: string | null, blocks: unknown[]) => {
      const page = store.doc.pages.find((p) => p.id === pageId)
      if (!page || !Array.isArray(blocks)) return null
      const made = blocks.map((raw) => {
        const src = (raw ?? {}) as Record<string, unknown>
        return { ...src, id: uid('b'), type: String(src.type ?? 'p') }
      })
      store.commit(() => {
        const at = afterId ? page.blocks.findIndex((b) => b.id === afterId) + 1 : page.blocks.length
        page.blocks.splice(at < 1 ? page.blocks.length : at, 0, ...(made as any))
      })
      editor.repaint()
      return made.map((m) => m.id)
    },
    newPage: (title: string, parent?: string) => {
      const page = { id: uid('p'), title: String(title ?? 'Untitled'), blocks: [], ...(parent ? { parent } : {}) }
      store.commit(() => { store.doc.pages.push(page as any) })
      editor.repaint()
      return page.id
    },
    loadDoc: (json: string): boolean => {
      const r = parseDoc(json)
      if (!r.ok) return false
      store.replaceDoc(r.doc)
      editor.repaint()
      return true
    },
  }

  if (!canWriteInPlace()) {
    // stated rather than discovered — the product-defining limitation on iOS
    console.info('[bento/spaces] this browser cannot write back to the file; every save makes a new copy')
  }
}

function banner(text: string, actions: Array<[string, () => void]> = []): void {
  const bar = document.createElement('div')
  bar.className = 'sp-banner'
  const span = document.createElement('span')
  span.textContent = text
  bar.append(span)
  for (const [label, fn] of actions) {
    const b = document.createElement('button')
    b.className = 'sp-btn'
    b.textContent = label
    b.addEventListener('click', () => { fn(); bar.remove() })
    bar.append(b)
  }
  const close = document.createElement('button')
  close.className = 'sp-btn'
  close.textContent = '✕'
  close.setAttribute('aria-label', 'Dismiss')
  close.addEventListener('click', () => bar.remove())
  bar.append(close)
  document.body.prepend(bar)
}

/** A snapshot that differs from the file we loaded means a crash lost work. */
async function offerRecovery(doc: SpacesDoc, store: Store, editor: Editor): Promise<void> {
  const snap = await getRecovery(doc.docId)
  if (!snap) return
  let saved: SpacesDoc
  try { saved = JSON.parse(snap.json) as SpacesDoc } catch { return }
  if (docContentKey(saved) === docContentKey(doc)) return
  banner(t('Unsaved changes from a previous session were found.'), [
    [t('Restore'), () => { store.replaceDoc(saved); editor.repaint() }],
    [t('Discard'), () => { void clearRecovery(doc.docId) }],
  ])
}
