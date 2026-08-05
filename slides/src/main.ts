// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The WebDeck authors
// Boot sequence. Order matters: capture the pristine document BEFORE any DOM
// mutation — the captured copy is what gets re-serialized on save.

import './styles.css'
import { anim } from './anim'
import { configureApp, appConfig } from '../../kernel/src/app.ts'
import {
  capturePristine, readEmbeddedDoc, serializeFile, serializeAuto, downloadFile,
  suggestedFileName, parseEnvelope, decryptEnvelope, setEncryptionPassword,
  registerPreview, extractDocJson,
} from './save'
import { buildSlidePreview } from './preview'
import { APP_VERSION, checkForUpdates, buildUpdatedFile, applyUpdate } from './update'
import { i18nApi, t, applyDirection } from './i18n'
import { parseDoc, type BentoDoc } from './model'
import { injectFonts } from './fonts'
import { Store } from './store'
import { Editor } from './editor/editor'
import { startPresentation } from './present'
import { SyncSession } from './sync/session'
import { onlineTransport, startSharing, stopSharing, disconnectOnline } from './sync/online'
import { renderWelcome, type WelcomeResult } from './welcome'

// Module-level references held for tear-down (close file → welcome screen).
let _store: Store | null = null
let _session: SyncSession | null = null

// Tell the kernel who this app is — must precede any kernel module use
// (window title suffix, save-picker label, update manifest + its `app` check).
configureApp({
  appId: 'webdeck',
  appName: 'webdeck',
  manifestUrl: 'https://webdeck.page/releases/slides/manifest.json',
})

// Every save writes a static rendering of page one into the shell, so file
// managers thumbnail the deck instead of the boot splash (src/preview.ts).
// Registered before capturePristine only for tidiness — nothing serializes
// this early — but it must be registered before the first save.
registerPreview((doc) => buildSlidePreview(doc as BentoDoc))

capturePristine()

// Chrome direction follows the VIEWER's language (Arabic/Hebrew/… get an RTL
// interface). Deliberately AFTER capturePristine: saves re-serialize the
// pristine clone, so the dir/lang attributes never reach a saved file — the
// same viewer-scoped rule as 'webdeck-lang' and reduced motion. The DOCUMENT
// never mirrors; styles.css pins every slide surface back to direction: ltr.
applyDirection()

// --- boot gates: password-encrypted files, read-only player files -----------

const embedded = readEmbeddedDoc()
const envelope = embedded ? parseEnvelope(embedded) : null
if (envelope) {
  void passwordGate()
} else {
  const doc = embedded ? parseDoc(embedded) : null
  if (doc) {
    bootWith(doc)
  } else {
    // No embedded document — show the welcome page (static web deployment).
    // The welcome page offers file-open, new-deck, and drag-and-drop;
    // on selection it calls bootWith through the ready callback.
    showWelcome()
  }
}

/** Encrypted file: ask for the password (looping on failure), then boot. */
async function passwordGate() {
  const gate = document.createElement('div')
  gate.className = 'ed-pwgate'
  gate.innerHTML =
    `<div class="ed-pwcard"><div class="ed-pwmark">🔒</div>` +
    `<h1>${t('This file is encrypted.')}</h1>` +
    `<p>${t('Enter password to open this deck')}</p>` +
    `<input type="password" autocomplete="current-password">` +
    `<button>${t('Unlock')}</button><div class="ed-pwerr"></div></div>`
  document.body.appendChild(gate)
  document.getElementById('webdeck-splash')?.remove()
  const input = gate.querySelector('input')!
  const button = gate.querySelector('button')!
  const err = gate.querySelector<HTMLElement>('.ed-pwerr')!
  const tryUnlock = async () => {
    const pass = input.value
    if (!pass) return
    button.setAttribute('disabled', '')
    const json = await decryptEnvelope(envelope!, pass)
    button.removeAttribute('disabled')
    if (json === null) {
      err.textContent = t('Wrong password — try again')
      input.select()
      return
    }
    const doc = parseDoc(json)
    if (!doc) {
      err.textContent = t('Wrong password — try again')
      return
    }
    setEncryptionPassword(pass) // saves + updates keep writing encrypted
    gate.remove()
    bootWith(doc)
  }
  button.addEventListener('click', () => void tryUnlock())
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void tryUnlock()
  })
  input.focus()
}

/**
 * No embedded document: show the welcome page.
 *
 * The welcome page offers three paths into the editor:
 * 1. Open a .webdeck.html or .webdeck.json file (with write-permission request)
 * 2. Start a new blank deck from the starter template
 * 3. Drag-and-drop a file (handled by the editor's existing drop listener)
 *
 * The drag-and-drop path is special: the welcome page stays up until a file
 * is dropped, at which point the editor's openDroppedDeck loads it and the
 * welcome page is dismissed by the editor's existing file-chip logic.
 */
function showWelcome() {
  let cleanup = () => {}
  const dismiss = renderWelcome((result: WelcomeResult) => {
    cleanup()
    bootWith(result.doc, result.openedAs)
  })

  // Drag-and-drop during the welcome screen: the editor isn't mounted yet,
  // so there is no openDroppedDeck listener. Listen here and forward.
  const onDrop = async (ev: DragEvent) => {
    const item = [...(ev.dataTransfer?.items ?? [])].find((i) => i.kind === 'file')
    const named = ev.dataTransfer?.files?.[0]?.name ?? ''
    if (!item || !/\.(webdeck\.html|json)$/i.test(named)) return
    ev.preventDefault()
    const file = ev.dataTransfer?.files?.[0]
    if (!file) return
    const content = await file.text()
    const json = extractDocJson(content, named)
    if (!json) return
    const doc = parseDoc(json)
    if (!doc) return
    cleanup()
    bootWith(doc, named)
  }
  const onDragOver = (ev: DragEvent) => {
    if ([...ev.dataTransfer?.items ?? []].some((i) => i.kind === 'file')) {
      ev.preventDefault()
    }
  }
  document.addEventListener('drop', onDrop)
  document.addEventListener('dragover', onDragOver)

  // Cleanup removes the welcome DOM and the temporary drag listeners
  cleanup = () => {
    document.removeEventListener('drop', onDrop)
    document.removeEventListener('dragover', onDragOver)
    dismiss()
  }
}

function bootWith(doc: BentoDoc, openedAs?: string) {
  if (doc.readonly) playerMode(doc)
  else editorMode(doc, openedAs)
}

/** Close the current file and return to the welcome screen. */
function closeFile() {
  if (_store?.dirty && !confirm(t('Close this file? Unsaved changes will be lost.'))) return

  if (_session) {
    disconnectOnline(_session)
    _session.destroy()
    _session = null
  }

  const app = document.getElementById('app')
  if (app) app.innerHTML = ''

  _store = null

  showWelcome()
}

/**
 * Read-only files are PLAYER files: they open straight into the show and
 * never expose the editor. Leaving the presentation lands on a minimal card.
 */
function playerMode(doc: BentoDoc) {
  document.title = `${doc.title} — ${appConfig().appName}`
  if (doc.fonts?.length) injectFonts(doc)
  document.getElementById('webdeck-splash')?.remove()
  const card = document.createElement('div')
  card.className = 'ed-player'
  card.innerHTML =
    `<div class="ed-playercard"><h1>${doc.title.replace(/</g, '&lt;')}</h1>` +
    `<p>${t('This is a presentation package — view and present only.')}</p>` +
    `<button class="ed-playgo">▶&nbsp; ${t('Present')}</button>` +
    `<button class="ed-playcopy">⤓&nbsp; ${t('Save a copy')}</button></div>`
  document.body.appendChild(card)
  const start = () => {
    card.style.display = 'none'
    startPresentation(doc, 0, () => {
      card.style.display = ''
    })
  }
  card.querySelector('.ed-playgo')!.addEventListener('click', start)
  card.querySelector('.ed-playcopy')!.addEventListener('click', () => {
    void serializeAuto(doc).then((html) => downloadFile(html, suggestedFileName(doc)))
  })
  ;(window as any).webdeck = { format: doc.format, doc, readonly: true }
  start()
}

function editorMode(doc: BentoDoc, openedAs?: string) {

document.title = `${doc.title} — ${appConfig().appName}`

// Embedded fonts: register @font-face rules from the asset table so text
// elements can use bundled families in the editor, presenter and thumbnails.
if (doc.fonts?.length) injectFonts(doc)

const store = new Store(doc)
const editor = new Editor(document.getElementById('app')!, store)
if (openedAs) editor.openedAs = openedAs

// Live collaboration (webdeck-sync): same-machine tabs sync automatically over
// BroadcastChannel; the online relay transport joins via the Share UI.
const session = new SyncSession(store)
editor.connectSync(session)

// Hold references for closeFile() tear-down
_store = store
_session = session

// Opening a link ending in #present starts the show immediately (player mode).
if (location.hash === '#present') {
  editor.present(true)
}

// Dismiss the boot splash (inline in index.html so it paints before this
// bundle parses). Hold it briefly so the assemble animation reads as a
// brand moment instead of a flicker; the pristine capture ran before this,
// so saved files keep the splash for their own next boot.
{
  const splash = document.getElementById('webdeck-splash')
  if (splash) {
    const wait = Math.max(0, 1250 - performance.now())
    setTimeout(() => {
      splash.classList.add('done')
      setTimeout(() => splash.remove(), 550)
    }, wait)
  }
}

// Small scripting surface for tooling and automation: read/replace the
// document model and serialize the full .webdeck.html file.
;(window as any).webdeck = {
  format: doc.format,
  get doc() {
    return store.doc
  },
  /** Close the current file and return to the welcome page. */
  closeFile: () => closeFile(),
  serialize: () => {
    session.stampInto(store.doc)
    return serializeFile(store.doc)
  },
  undo: () => store.undo(),
  redo: () => store.redo(),
  get selection() {
    return store.selection.slice()
  },
  /** animation engine, exposed for scripting/diagnostics */
  anim,
  /** i18n: t/locale/setLocale/choices — setLocale('x-pseudo') audits the sweep */
  i18n: i18nApi,
  /** live-collaboration session: actor id, connected peers, force a diff-flush */
  sync: {
    get actor() {
      return session.actor
    },
    peers: () => session.peers(),
    flush: () => session.flush(),
    transports: () => session.transportKinds,
    /** start an online session (mints doc.collab, connects the relay) */
    share: () => {
      void startSharing(session, store)
      return store.doc.collab
    },
    unshare: () => stopSharing(session, store),
    online: () => onlineTransport()?.status ?? 'off',
  },
  /**
   * AI/tooling round-trip: replace the whole document from a JSON string
   * (the contents of #webdeck-doc). Validates via parseDoc; returns false and
   * changes nothing on invalid input. Undoable in the editor.
   */
  loadDoc(json: string): boolean {
    const next = parseDoc(json)
    if (!next) return false
    store.replaceDoc(next)
    return true
  },
  /**
   * Self-update surface (all user/tooling-initiated, never automatic):
   * check() fetches + signature-verifies the release manifest; build()
   * returns the updated file's html (this doc inside the new shell);
   * apply() downloads it. check(url) accepts an override for testing.
   */
  updates: {
    version: APP_VERSION,
    check: (url?: string) => checkForUpdates(url),
    build: (release: any) => {
      session.stampInto(store.doc)
      return buildUpdatedFile(release, store.doc)
    },
    apply: (release: any) => {
      session.stampInto(store.doc)
      return applyUpdate(release, store.doc)
    },
  },
  /**
   * Flat list of every review comment thread — the entry point for tooling
   * and AI agents processing the deck ("fix everything people flagged"):
   * each item carries the slide, a typed anchor (element / point / slide),
   * author, text, replies and resolved state.
   */
  comments() {
    return store.doc.slides.flatMap((s, slideIndex) =>
      (s.comments ?? []).map((c) => ({
        slideId: s.id,
        slideIndex,
        id: c.id,
        anchor: c.elementId
          ? { type: 'element' as const, elementId: c.elementId }
          : typeof c.x === 'number'
            ? { type: 'point' as const, x: c.x, y: c.y }
            : { type: 'slide' as const },
        author: c.author,
        at: c.at,
        text: c.text,
        replies: c.replies ?? [],
        resolved: !!c.resolved,
      })),
    )
  },
}

} // editorMode
