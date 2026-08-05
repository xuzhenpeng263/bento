// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The WebDeck authors
// Welcome page shown when the editor boots without an embedded document
// (static web deployment). Offers file-open, new-file, and drag-and-drop.

import { t } from './i18n'
import { openFilePicker, extractDocJson } from './save'
import { parseDoc, newDoc, type BentoDoc } from './model'

export interface WelcomeResult {
  doc: BentoDoc
  /** The file name this document was loaded from, if any. */
  openedAs?: string
  /** Whether we have a writable handle for the opened file. */
  writable: boolean
}

type Callback = (result: WelcomeResult) => void

/**
 * Render the welcome page over the splash. Returns a cleanup function.
 */
export function renderWelcome(onReady: Callback): () => void {
  // Dismiss the boot splash first — the welcome page replaces it
  const splash = document.getElementById('webdeck-splash')
  if (splash) {
    splash.classList.add('done')
    setTimeout(() => splash.remove(), 550)
  }

  const root = document.createElement('div')
  root.id = 'webdeck-welcome'
  root.innerHTML = `
    <div class="bw-card">
      <img class="bw-mark" src="data:image/png;base64,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" width="80" height="80" alt="WebDeck">
      <h1 class="bw-word"><b>WebDeck</b></h1>
      <p class="bw-desc">${t('Presentations that live in one file — open one or start fresh.')}</p>
      <div class="bw-actions">
        <button class="bw-btn bw-btn-primary" id="bw-open">📂&nbsp; ${t('Open File')}</button>
        <button class="bw-btn" id="bw-new">✨&nbsp; ${t('New File…')}</button>
      </div>
      <p class="bw-hint">${t('Or drop a .webdeck.html or .webdeck.json file anywhere on this page.')}</p>
    </div>
  `
  document.body.appendChild(root)

  const openBtn = root.querySelector('#bw-open') as HTMLButtonElement
  const newBtn = root.querySelector('#bw-new') as HTMLButtonElement

  openBtn.addEventListener('click', () => void openAndBoot(root, onReady))
  newBtn.addEventListener('click', () => void newFileAndBoot(root, onReady))

  // Keyboard shortcut: Ctrl+O to open
  const onKey = (ev: KeyboardEvent) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'o') {
      ev.preventDefault()
      void openAndBoot(root, onReady)
    }
  }
  document.addEventListener('keydown', onKey)

  function cleanup(el: HTMLElement) {
    document.removeEventListener('keydown', onKey)
    el.remove()
  }

  return () => cleanup(root)
}

async function openAndBoot(root: HTMLElement, onReady: Callback) {
  const openBtn = root.querySelector('#bw-open') as HTMLButtonElement
  const hint = root.querySelector('.bw-hint') as HTMLElement

  openBtn.disabled = true
  openBtn.textContent = '⏳ ' + t('Opening…')

  try {
    const picked = await openFilePicker()
    if (!picked) {
      openBtn.disabled = false
      openBtn.innerHTML = '📂&nbsp; ' + t('Open File')
      return
    }

    const { content, name, handle } = picked
    const json = extractDocJson(content, name)
    if (!json) {
      if (hint) {
        hint.textContent = t('{name} doesn\'t contain a WebDeck document — try another file.', { name })
        hint.classList.add('bw-err')
      }
      openBtn.disabled = false
      openBtn.innerHTML = '📂&nbsp; ' + t('Open File')
      return
    }

    const doc = parseDoc(json)
    if (!doc) {
      if (hint) {
        hint.textContent = t('{name} isn\'t a valid WebDeck document.', { name })
        hint.classList.add('bw-err')
      }
      openBtn.disabled = false
      openBtn.innerHTML = '📂&nbsp; ' + t('Open File')
      return
    }

    root.remove()
    onReady({ doc, openedAs: name, writable: !!handle })
  } catch (err) {
    console.error('webdeck: open file failed', err)
    if (hint) {
      hint.textContent = t('Couldn\'t open that file — see console for details.')
      hint.classList.add('bw-err')
    }
    openBtn.disabled = false
    openBtn.innerHTML = '📂&nbsp; ' + t('Open File')
  }
}

/**
 * Create a new .webdeck.json file via the save picker, write an empty document
 * into it, and boot the editor with a writable handle from the start.
 *
 * In browsers without the File System Access API the file is downloaded
 * and the editor opens with a download-on-save fallback.
 */
async function newFileAndBoot(root: HTMLElement, onReady: Callback) {
  const newBtn = root.querySelector('#bw-new') as HTMLButtonElement
  const hint = root.querySelector('.bw-hint') as HTMLElement

  newBtn.disabled = true
  newBtn.textContent = '⏳ …'

  try {
    const doc = newDoc()
    const json = JSON.stringify(doc, null, 2)
    const base = (doc.title || 'Untitled').replace(/[^\w\d-]+/g, '_').replace(/^_+|_+$/g, '')
    const filename = `${base || 'Untitled'}.webdeck.json`
    // Dynamically import save functions to avoid a static dependency loop
    const { adoptFileHandle } = await import('./save')

    const hasFs = typeof (window as any).showSaveFilePicker === 'function'

    if (hasFs) {
      // File System Access API: create the file, get a writable handle
      let handle: any = null
      try {
        handle = await (window as any).showSaveFilePicker({
          suggestedName: filename,
          id: 'webdeck-new',
          types: [{ description: 'WebDeck JSON', accept: { 'application/json': ['.json'] } }],
        })
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          newBtn.disabled = false
          newBtn.innerHTML = '✨&nbsp; ' + t('New File…')
          return
        }
        throw err
      }

      // Write the initial document
      const writable = await handle.createWritable()
      await writable.write(new Blob([json], { type: 'application/json' }))
      await writable.close()

      adoptFileHandle(handle as any)
      root.remove()
      onReady({ doc, openedAs: handle.name, writable: true })
    } else {
      // Fallback: download the JSON file
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 5000)

      root.remove()
      onReady({ doc, writable: false })
    }
  } catch (err) {
    console.error('webdeck: new file failed', err)
    if (hint) {
      hint.textContent = t('Couldn\'t create that file — see console for details.')
      hint.classList.add('bw-err')
    }
    newBtn.disabled = false
    newBtn.innerHTML = '✨&nbsp; ' + t('New File…')
  }
}
