// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
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
  const splash = document.getElementById('bento-splash')
  if (splash) {
    splash.classList.add('done')
    setTimeout(() => splash.remove(), 550)
  }

  const root = document.createElement('div')
  root.id = 'bento-welcome'
  root.innerHTML = `
    <div class="bw-card">
      <div class="bw-mark"><i class="bw-a"></i><i class="bw-b"></i><i class="bw-c"></i></div>
      <h1 class="bw-word"><b>Bento</b>/Slides</h1>
      <p class="bw-desc">${t('Presentations that live in one file — open one or start fresh.')}</p>
      <div class="bw-actions">
        <button class="bw-btn bw-btn-primary" id="bw-open">📂&nbsp; ${t('Open File')}</button>
        <button class="bw-btn" id="bw-new">✨&nbsp; ${t('New File…')}</button>
      </div>
      <p class="bw-hint">${t('Or drop a .bento.html or .bento.json file anywhere on this page.')}</p>
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
        hint.textContent = t('{name} doesn\'t contain a Bento document — try another file.', { name })
        hint.classList.add('bw-err')
      }
      openBtn.disabled = false
      openBtn.innerHTML = '📂&nbsp; ' + t('Open File')
      return
    }

    const doc = parseDoc(json)
    if (!doc) {
      if (hint) {
        hint.textContent = t('{name} isn\'t a valid Bento document.', { name })
        hint.classList.add('bw-err')
      }
      openBtn.disabled = false
      openBtn.innerHTML = '📂&nbsp; ' + t('Open File')
      return
    }

    root.remove()
    onReady({ doc, openedAs: name, writable: !!handle })
  } catch (err) {
    console.error('bento: open file failed', err)
    if (hint) {
      hint.textContent = t('Couldn\'t open that file — see console for details.')
      hint.classList.add('bw-err')
    }
    openBtn.disabled = false
    openBtn.innerHTML = '📂&nbsp; ' + t('Open File')
  }
}

/**
 * Create a new .bento.json file via the save picker, write an empty document
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
    const filename = `${base || 'Untitled'}.bento.json`
    // Dynamically import save functions to avoid a static dependency loop
    const { adoptFileHandle } = await import('./save')

    const hasFs = typeof (window as any).showSaveFilePicker === 'function'

    if (hasFs) {
      // File System Access API: create the file, get a writable handle
      let handle: any = null
      try {
        handle = await (window as any).showSaveFilePicker({
          suggestedName: filename,
          id: 'bento-new',
          types: [{ description: 'Bento JSON', accept: { 'application/json': ['.json'] } }],
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
    console.error('bento: new file failed', err)
    if (hint) {
      hint.textContent = t('Couldn\'t create that file — see console for details.')
      hint.classList.add('bw-err')
    }
    newBtn.disabled = false
    newBtn.innerHTML = '✨&nbsp; ' + t('New File…')
  }
}
