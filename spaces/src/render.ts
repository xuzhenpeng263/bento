// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// model → DOM. ONE renderer for the editor, the reader, print and (later) the
// file-manager preview, so those surfaces can never disagree about what a
// document looks like.
//
// The renderer emits REAL SEMANTIC TAGS — h1..h3, ul/ol/li, blockquote,
// pre>code, figure — never divs with classes. That buys the screen-reader
// story, native ⌘F, print fidelity and lossless markdown export at once, from
// one decision.

import { type SpacesDoc, type Page, type Block, isRemote } from './model'
import { sanitizeInline, inertBody, esc } from './sanitize'
import { t } from './i18n'

export interface RenderOpts {
  /** editable per-block hosts (the editor); false for reader/print */
  editable?: boolean
  /** resolve a page id to its title, for link chips and pagelink blocks */
  titleOf?: (pageId: string) => string | undefined
  /** collapsed toggles render OPEN — print always passes this */
  forceOpen?: boolean
  /**
   * Has the READER agreed to load this remote url?
   *
   * A VIEWER-scoped decision, never a document field — the same rule as locale
   * and reduced motion. Putting consent in the file would mean the author
   * decides whether the reader phones home, which is precisely backwards, and
   * it would travel to the next person the file is mailed to.
   */
  allowRemote?: (src: string) => boolean
}

/** Blocks that group into one list element when adjacent. */
const LIST_OF: Record<string, 'ul' | 'ol'> = { bullet: 'ul', number: 'ol', todo: 'ul' }

const TAG_OF: Record<string, string> = {
  p: 'p', h1: 'h1', h2: 'h2', h3: 'h3', quote: 'blockquote',
  bullet: 'li', number: 'li', todo: 'li',
}

/**
 * Render one page's blocks.
 *
 * Nesting is `Block.parent`, and the array is pre-order, so a child always
 * follows its parent. That is what lets a single forward pass build the tree
 * without a lookup table.
 */
export function renderBlocks(page: Page, doc: SpacesDoc, opts: RenderOpts = {}): DocumentFragment {
  const frag = document.createDocumentFragment()
  // stack of open containers, innermost last: [blockId, element]
  const stack: Array<[string, HTMLElement]> = []
  let list: { el: HTMLElement; kind: 'ul' | 'ol'; under: string } | null = null

  const hostFor = (parent: string | undefined): HTMLElement | DocumentFragment => {
    while (stack.length && stack[stack.length - 1][0] !== parent) stack.pop()
    return stack.length ? stack[stack.length - 1][1] : frag
  }

  for (const b of page.blocks) {
    const host = hostFor(b.parent)
    const kind = LIST_OF[b.type]

    // adjacent same-kind list items share one <ul>/<ol>
    if (kind) {
      if (!list || list.kind !== kind || list.under !== (b.parent ?? '')) {
        const el: HTMLElement = document.createElement(kind)
        el.className = 'sp-list'
        host.appendChild(el)
        list = { el, kind, under: b.parent ?? '' }
      }
    } else {
      list = null
    }

    const node = renderBlock(b, doc, opts)
    ;(kind && list ? list.el : host).appendChild(node)

    // a toggle owns the blocks whose parent is its id
    if (b.type === 'toggle') {
      const body = document.createElement('div')
      body.className = 'sp-toggle-body'
      if (!(opts.forceOpen || b.open)) body.hidden = true
      node.appendChild(body)
      stack.push([b.id, body])
      list = null
    }
  }
  return frag
}

export function renderBlock(b: Block, doc: SpacesDoc, opts: RenderOpts = {}): HTMLElement {
  const type = b.type
  const el = document.createElement(TAG_OF[type] ?? 'div')
  el.dataset.blockId = b.id
  el.dataset.type = type
  el.className = `sp-b sp-b-${type}`

  switch (type) {
    case 'divider':
      el.className = 'sp-b sp-b-divider'
      el.appendChild(document.createElement('hr'))
      return el

    case 'code': {
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      if (b.lang) code.className = `language-${esc(String(b.lang))}`
      code.textContent = textFromHtml(b.html)
      if (opts.editable) { code.contentEditable = 'true'; code.dataset.edit = b.id }
      pre.appendChild(code)
      el.appendChild(pre)
      return el
    }

    case 'image': {
      const fig = document.createElement('figure')
      const rawSrc = String(b.src ?? '')

      // A REMOTE image is not loaded until the reader asks for it.
      //
      // Measured: a space carrying <img src="https://…/pixel.png"> requests it
      // on open. In a format whose whole point is that you can mail it, that is
      // a tracking pixel — the recipient's IP and the moment they opened your
      // document, delivered to whoever wrote the file. It also breaks PLATFORM
      // §1: no network is required to open a document.
      //
      // This costs authors nothing, because the editor never writes a remote
      // src: picked images are downscaled, interned by content hash and stored
      // as `asset:`. Only hand- or agent-authored documents carry URLs, and for
      // those the reader gets a placeholder naming the host and a button. One
      // click, per image, informed — the model every mail client settled on.
      if (isRemote(rawSrc) && !opts.allowRemote?.(rawSrc)) {
        fig.appendChild(remoteImagePlaceholder(rawSrc, b, opts))
        if (b.caption) {
          const cap = document.createElement('figcaption')
          cap.innerHTML = sanitizeInline(String(b.caption))
          fig.appendChild(cap)
        }
        el.appendChild(fig)
        return el
      }

      const img = document.createElement('img')
      img.src = resolveSrc(rawSrc, doc)
      img.alt = String(b.alt ?? '')
      if (b.width) img.style.width = `${Math.max(10, Math.min(100, Number(b.width)))}%`
      // intrinsic size holds the aspect box while the image decodes, so the
      // page does not reflow under the reader's cursor
      if (b.w && b.h) { img.width = Number(b.w); img.height = Number(b.h) }
      fig.appendChild(img)
      if (b.caption) {
        const cap = document.createElement('figcaption')
        cap.innerHTML = sanitizeInline(String(b.caption))
        fig.appendChild(cap)
      }
      el.appendChild(fig)
      return el
    }

    case 'pagelink': {
      const a = document.createElement('a')
      const target = String(b.page ?? '')
      a.href = `#p/${target}`
      a.className = 'sp-pagecard'
      const title = opts.titleOf?.(target)
      a.textContent = title ?? '(missing page)'
      if (!title) a.classList.add('sp-dead')
      el.appendChild(a)
      return el
    }

    case 'todo': {
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = !!b.done
      box.className = 'sp-check'
      // the checkbox is a control, not text: it must not be inside the
      // editable host or typing would land in it
      el.appendChild(box)
      el.appendChild(inlineHost(b, opts))
      if (b.done) el.classList.add('sp-done')
      return el
    }

    case 'toggle': {
      const twist = document.createElement('button')
      twist.className = 'sp-twist'
      twist.type = 'button'
      twist.setAttribute('aria-expanded', String(!!(opts.forceOpen || b.open)))
      twist.setAttribute('aria-label', 'Toggle section')
      twist.textContent = '▸'
      el.appendChild(twist)
      el.appendChild(inlineHost(b, opts))
      return el
    }

    default:
      el.appendChild(inlineHost(b, opts))
      return el
  }
}

/** The editable text host. Per-block, never one big editable container — that
 *  is what keeps Selection block-scoped and stops a merge re-minting ids. */
function inlineHost(b: Block, opts: RenderOpts): HTMLElement {
  const inner = document.createElement('span')
  inner.className = 'sp-text'
  inner.dataset.edit = b.id
  // direction is per-block from the CONTENT, inside a container pinned by the
  // document's theme.dir — PLATFORM §8's two-layer rule
  inner.dir = 'auto'
  if (opts.editable) inner.contentEditable = 'true'
  inner.innerHTML = sanitizeInline(b.html ?? '')
  if (!b.html) inner.dataset.empty = '1'
  return inner
}

// Untrusted html — parse INERT. A detached div still loads what it creates,
// so `<img src="404" onerror>` in a code block would run its handler here.
// See sanitize.ts inertBody().
const textFromHtml = (html: string | undefined): string => {
  if (!html) return ''
  return inertBody(html).textContent ?? ''
}

export function resolveSrc(src: string, doc: SpacesDoc): string {
  if (src.startsWith('asset:')) return doc.assets?.[src.slice(6)] ?? ''
  return src
}


/** The host a reader is being asked to trust, or the raw src if it will not parse. */
function remoteHost(src: string): string {
  try { return new URL(src, 'https://x.invalid').host || src } catch { return src }
}

/**
 * What stands in for an unloaded remote image: what it is, WHERE it would come
 * from, and a button. Naming the host is the point — "load images" with no
 * indication of who is being contacted is not consent.
 */
function remoteImagePlaceholder(src: string, b: Block, opts: RenderOpts): HTMLElement {
  const box = document.createElement('div')
  box.className = 'sp-remote'
  box.dataset.remoteSrc = src

  const line = document.createElement('div')
  line.className = 'sp-remote-line'
  line.textContent = t('Image from {host}', { host: remoteHost(src) })
  box.appendChild(line)

  const why = document.createElement('div')
  why.className = 'sp-remote-why'
  why.textContent = t('Not loaded — opening it would tell that site you opened this space.')
  box.appendChild(why)

  const alt = String(b.alt ?? '')
  if (alt) {
    const a = document.createElement('div')
    a.className = 'sp-remote-alt'
    a.textContent = alt
    box.appendChild(a)
  }

  if (opts.editable !== false || opts.allowRemote) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'sp-btn sp-remote-load'
    btn.textContent = t('Load this image')
    btn.dataset.loadRemote = src
    box.appendChild(btn)
  }
  return box
}

/**
 * A whole page, including its title. The OUTER wrapper stays ltr — scrollLeft
 * and every coordinate calculation change meaning under rtl — and the INNER
 * container carries the document's declared base direction.
 */
export function renderPage(page: Page, doc: SpacesDoc, opts: RenderOpts = {}): HTMLElement {
  const art = document.createElement('article')
  art.className = 'sp-page'
  art.style.direction = 'ltr'

  const inner = document.createElement('div')
  inner.className = 'sp-page-inner'
  inner.dir = doc.theme.dir ?? 'ltr'
  if (doc.theme.measure) inner.style.maxWidth = `${doc.theme.measure}px`

  const h = document.createElement('h1')
  h.className = 'sp-title'
  h.dataset.pageTitle = page.id
  h.dir = 'auto'
  if (opts.editable) h.contentEditable = 'true'
  h.textContent = page.title
  inner.appendChild(h)

  inner.appendChild(renderBlocks(page, doc, opts))
  art.appendChild(inner)
  return art
}
