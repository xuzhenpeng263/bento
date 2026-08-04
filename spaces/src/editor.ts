// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The bento/spaces editor.
//
// The keyboard IS the interface here, so the keymap is specified rather than
// discovered, and every block is its own contentEditable host — never one big
// editable container. That is what keeps Selection block-scoped, so splitting
// and merging blocks can never re-mint an id, and ids are what links,
// backlinks and (later) collaboration key on.

import { type Block, newBlock, newPage } from './model'
import { Store } from './store'
import { renderPage } from './render'
import { canonicalize, sanitizeInline, textOf } from './sanitize'
import { countOutsideTags, replaceOutsideTags } from './findreplace'
import { t } from './i18n'
import { openAbout } from './about'
import { ICONS, type IconName } from './icons'
import { internAsset, prepareImage, humanBytes, IMAGE_EMBED_BUDGET, blobToDataUri } from './assets'

const CTRL = navigator.platform.toLowerCase().includes('mac') ? 'metaKey' : 'ctrlKey'

/** Markdown prefixes that convert a block as you type them. */
const AUTOFORMAT: Array<[RegExp, string, (b: Block) => void]> = [
  [/^# $/, 'h1', () => {}],
  [/^## $/, 'h2', () => {}],
  [/^### $/, 'h3', () => {}],
  [/^- $/, 'bullet', () => {}],
  [/^\* $/, 'bullet', () => {}],
  [/^1\. $/, 'number', () => {}],
  [/^> $/, 'quote', () => {}],
  [/^\[\] $/, 'todo', (b) => { b.done = false }],
  [/^\[ \] $/, 'todo', (b) => { b.done = false }],
  [/^```$/, 'code', () => {}],
  [/^--- $/, 'divider', () => {}],
]

const SLASH_ITEMS: Array<{ type: string; label: string; hint: string; icon: IconName }> = [
  { type: 'p', label: 'Text', hint: 'Plain paragraph', icon: 'text' },
  { type: 'h1', label: 'Heading 1', hint: '#', icon: 'h1' },
  { type: 'h2', label: 'Heading 2', hint: '##', icon: 'h2' },
  { type: 'h3', label: 'Heading 3', hint: '###', icon: 'h3' },
  { type: 'bullet', label: 'Bulleted list', hint: '-', icon: 'bullet' },
  { type: 'number', label: 'Numbered list', hint: '1.', icon: 'number' },
  { type: 'todo', label: 'To-do', hint: '[]', icon: 'todo' },
  { type: 'toggle', label: 'Toggle', hint: 'Collapsible section', icon: 'toggle' },
  { type: 'quote', label: 'Quote', hint: '>', icon: 'quote' },
  { type: 'code', label: 'Code', hint: '```', icon: 'code' },
  { type: 'divider', label: 'Divider', hint: '---', icon: 'divider' },
  { type: 'pagelink', label: 'Link to page', hint: 'A card that opens a page', icon: 'link' },
  { type: 'image', label: 'Image', hint: 'Embedded in the file', icon: 'image' },
]

export class Editor {
  readonly store: Store
  private root: HTMLElement
  private main!: HTMLElement
  private sidebar!: HTMLElement
  private statusEl!: HTMLElement
  private overlay: HTMLElement | null = null
  /** set while the editor is writing the DOM, so input handlers stand down */
  private painting = false
  /** reading view: the document without the machinery for changing it */
  private reading = false
  /**
   * Remote image urls this READER has agreed to load, this session only.
   *
   * Never persisted and never written to the document: consent belongs to the
   * person opening the file, and saving it would carry one reader's decision to
   * everyone the file is forwarded to. Re-opening asks again, which is the
   * correct default for something that leaks an IP address.
   */
  private allowedRemote = new Set<string>()
  private undoB: HTMLButtonElement | null = null
  private readB: HTMLButtonElement | null = null
  private redoB: HTMLButtonElement | null = null
  onSave: (() => void) | null = null
  onSaveAs: ((suffix: string) => void) | null = null
  onPrint: (() => void) | null = null

  constructor(root: HTMLElement, store: Store) {
    this.root = root
    this.store = store
    this.build()
    this.store.on('tree', () => this.paintTree())
    this.store.on('page', () => { this.paintPage(); this.paintTree() })
    this.store.on('doc', () => { this.status(t('Edited')); this.syncHistoryButtons() })
    window.addEventListener('popstate', () => this.fromHash())
    this.fromHash()
  }

  // ---- chrome -------------------------------------------------------------
  private build(): void {
    this.root.innerHTML = ''
    this.root.className = 'sp-app'

    const bar = el('header', 'sp-bar')
    const mark = el('span', 'sp-mark')
    mark.innerHTML = 'bento<span>/</span>spaces'

    // Pages panel toggle — on every width, like slides' Slides/Format toggles.
    // A sidebar you cannot put away is a sidebar you resent on a laptop.
    const pagesB = iconBtn('panelLeft', t('Pages — show or hide the page list'), () => this.toggleSidebar())
    pagesB.classList.add('sp-panel-toggle')

    const title = document.createElement('input')
    title.className = 'sp-doctitle'
    title.value = this.store.doc.title
    title.setAttribute('aria-label', t('Space name'))
    title.addEventListener('input', () => {
      this.store.runEdit('__title', () => { this.store.doc.title = title.value })
      document.title = `${title.value} — bento/spaces`
    })
    this.statusEl = el('span', 'sp-status')

    // insert — the block menu, reachable without knowing "/" exists
    const insert = this.dropdown('plus', t('Insert'), t('Insert a block — text, headings, lists, code, images'), (menu, close) => {
      for (const item of SLASH_ITEMS) {
        menu.append(this.menuItem(item.icon, t(item.label), t(item.hint), () => {
          close()
          const page = this.store.page
          if (!page) return
          const fresh = newBlock(item.type === 'pagelink' ? 'p' : item.type)
          this.store.commit(() => { page.blocks.push(fresh) })
          this.paintPage()
          if (item.type === 'pagelink') this.insertPageCard(fresh.id)
          else if (item.type === 'image') void this.pickImage(fresh.id)
          else this.focusBlock(fresh.id)
        }))
      }
    })

    const newPageB = iconBtn('page', t('New page (⌘⌥N)'), () => this.newPage())

    this.undoB = iconBtn('undo', t('Undo (⌘Z)'), () => { this.store.undo(); this.repaint() })
    this.redoB = iconBtn('redo', t('Redo (⇧⌘Z)'), () => { this.store.redo(); this.repaint() })

    const search = iconBtn('search', t('Search all pages (⌘K)'), () => this.openSearch())
    const printB = iconBtn('print', t('Print or save as PDF (⌘P)'), () => this.openPrint())
    this.readB = iconBtn('eye', t('Reading view — the pages without the editing tools'), () => this.toggleReading())
    const about = iconBtn('info', t('About this space'), () =>
      openAbout({ store: this.store, onRepaint: () => this.build() }))

    // save is a split control, as in slides: the common action, and the
    // less-common ways of writing this document somewhere else
    const saveB = iconBtn('save', t('Save (⌘S)'), () => this.onSave?.())
    saveB.classList.add('sp-primary')
    saveB.append(document.createTextNode(t('Save')))
    const saveMore = this.dropdown('chevronDown', '', t('Other ways to save'), (menu, close) => {
      menu.append(this.menuItem('copy', t('Save a copy…'), t('A second file — the original is left alone'), () => {
        close(); void this.saveAs('copy')
      }))
      menu.append(this.menuItem('markdown', t('Export as Markdown…'), t('Every page, as one .md file'), () => {
        close(); this.exportMarkdown()
      }))
      menu.append(this.menuItem('print', t('Print / PDF…'), t('The whole space, or just this page'), () => {
        close(); this.openPrint()
      }))
      menu.append(this.menuItem('lock', t('Password…'), t('Encrypt the document inside this file'), () => {
        close(); openAbout({ store: this.store, onRepaint: () => this.build() })
      }))
    })
    saveMore.classList.add('sp-caret')

    bar.append(pagesB, mark, title, this.statusEl, insert, newPageB,
      this.undoB, this.redoB, search, this.readB, printB, about, saveB, saveMore)

    this.sidebar = el('nav', 'sp-side')
    this.sidebar.setAttribute('aria-label', t('Pages'))
    this.main = el('main', 'sp-main')

    const body = el('div', 'sp-body')
    body.append(this.sidebar, this.main)
    this.root.append(bar, body)

    this.paintTree()
    this.paintPage()
    this.syncHistoryButtons()
    document.addEventListener('keydown', (e) => this.onKey(e), true)
  }

  /**
   * Reading view.
   *
   * Not a separate renderer — the SAME renderer with `editable` off, so what a
   * reader sees is what an editor sees minus the machinery. A second read-only
   * renderer would drift, and the drift would only show up in the view nobody
   * develops in.
   *
   * It is a VIEW, never a document state: nothing about it is written to the
   * file, so a space does not arrive locked because its author was reading when
   * they saved.
   */
  private toggleReading(force?: boolean): void {
    this.reading = force ?? !this.reading
    this.root.classList.toggle('sp-reading', this.reading)
    this.readB?.classList.toggle('sp-on', this.reading)
    this.readB?.setAttribute('aria-pressed', String(this.reading))
    document.querySelector('.sp-findbar')?.remove()
    this.paintPage()
    this.status(this.reading ? t('Reading view — press Esc or the eye to edit') : t('Editing'))
  }

  /** Undo/redo must LOOK unavailable when they are, or they read as broken. */
  private syncHistoryButtons(): void {
    if (this.undoB) this.undoB.disabled = !this.store.canUndo
    if (this.redoB) this.redoB.disabled = !this.store.canRedo
  }

  /** A topbar dropdown: button + menu, closed by choosing, Esc, or clicking away. */
  private dropdown(
    icon: IconName, label: string, tip: string,
    fill: (menu: HTMLElement, close: () => void) => void,
  ): HTMLElement {
    const wrap = el('div', 'sp-dd')
    const b = document.createElement('button')
    b.className = 'sp-btn'
    b.type = 'button'
    b.innerHTML = ICONS[icon]
    if (label) b.append(document.createTextNode(label))
    b.title = tip
    b.setAttribute('aria-label', tip)
    b.setAttribute('aria-haspopup', 'menu')
    const menu = el('div', 'sp-ddmenu')
    menu.setAttribute('role', 'menu')
    const close = () => { wrap.classList.remove('sp-open'); b.setAttribute('aria-expanded', 'false') }
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      const open = !wrap.classList.contains('sp-open')
      for (const other of document.querySelectorAll('.sp-dd.sp-open')) other.classList.remove('sp-open')
      wrap.classList.toggle('sp-open', open)
      b.setAttribute('aria-expanded', String(open))
      if (open) { menu.innerHTML = ''; fill(menu, close) }
    })
    document.addEventListener('click', close)
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })
    wrap.append(b, menu)
    return wrap
  }

  private menuItem(icon: IconName, label: string, hint: string, onClick: () => void): HTMLElement {
    const b = document.createElement('button')
    b.className = 'sp-dditem'
    b.type = 'button'
    b.setAttribute('role', 'menuitem')
    b.innerHTML = `<span class="sp-result-ico">${ICONS[icon]}</span>` +
      `<span class="sp-result-txt"><strong>${escapeHtml(label)}</strong>` +
      (hint ? `<span>${escapeHtml(hint)}</span>` : '') + `</span>`
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick() })
    return b
  }

  /** Open/close the page drawer on narrow screens, with a scrim to tap away. */
  private toggleSidebar(force?: boolean): void {
    const open = force ?? !this.sidebar.classList.contains('sp-open')
    this.sidebar.classList.toggle('sp-open', open)
    document.querySelector('.sp-scrim')?.remove()
    if (open) {
      const scrim = el('div', 'sp-scrim')
      scrim.addEventListener('click', () => this.toggleSidebar(false))
      document.body.append(scrim)
    }
  }

  status(msg: string): void {
    this.statusEl.textContent = msg
    this.statusEl.classList.add('sp-on')
    clearTimeout((this.statusEl as any)._t)
    ;(this.statusEl as any)._t = setTimeout(() => this.statusEl.classList.remove('sp-on'), 1800)
  }

  // ---- the page tree ------------------------------------------------------
  private paintTree(): void {
    const s = this.store
    this.sidebar.innerHTML = ''
    const head = el('div', 'sp-side-head')
    head.append(el('span', 'sp-side-title', t('Pages')))
    head.append(iconBtn('plus', t('New page (⌘⌥N)'), () => this.newPage()))
    this.sidebar.append(head)

    const list = el('ul', 'sp-tree')
    for (const { page, depth } of s.tree()) {
      if (page.archived) continue
      const li = document.createElement('li')
      li.style.paddingInlineStart = `${depth * 14}px`
      const a = document.createElement('a')
      a.href = `#p/${page.id}`
      a.className = 'sp-treelink' + (page.id === s.pageId ? ' sp-here' : '')
      const ico = el('span', 'sp-tree-ico')
      ico.innerHTML = pageIcon(page.icon)
      const label = document.createElement('span')
      label.textContent = page.title || t('Untitled')
      a.append(ico, label)
      a.draggable = true
      a.addEventListener('click', (e) => { e.preventDefault(); s.goToPage(page.id); this.toggleSidebar(false) })
      a.addEventListener('dragstart', (e) => e.dataTransfer?.setData('text/bento-page', page.id))
      a.addEventListener('dragover', (e) => { e.preventDefault(); a.classList.add('sp-drop') })
      a.addEventListener('dragleave', () => a.classList.remove('sp-drop'))
      a.addEventListener('drop', (e) => {
        e.preventDefault(); a.classList.remove('sp-drop')
        const moved = e.dataTransfer?.getData('text/bento-page')
        if (moved && moved !== page.id) this.reparentPage(moved, page.id)
      })
      const more = document.createElement('button')
      more.className = 'sp-rowmore'
      more.type = 'button'
      more.innerHTML = ICONS.more
      more.title = t('Page options')
      more.setAttribute('aria-label', t('Page options'))
      more.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.openPageMenu(page.id, more) })
      a.append(more)

      li.append(a)
      list.append(li)
    }
    if (!list.childElementCount) list.append(el('li', 'sp-side-empty', t('No pages yet')))
    this.sidebar.append(list)

    // Archived pages are OUT OF THE WAY, never invisible: they are still
    // searchable and linkable, and someone about to share the file needs to be
    // able to see what is going with it.
    const archived = s.doc.pages.filter((p) => p.archived)
    if (archived.length) {
      const det = document.createElement('details')
      det.className = 'sp-archived'
      const sum = document.createElement('summary')
      sum.textContent = t('Archived ({n})', { n: archived.length })
      det.append(sum)
      const al = el('ul', 'sp-tree')
      for (const page of archived) {
        const li = document.createElement('li')
        const a = document.createElement('a')
        a.href = `#p/${page.id}`
        a.className = 'sp-treelink sp-arch-row' + (page.id === s.pageId ? ' sp-here' : '')
        const ico = el('span', 'sp-tree-ico')
        ico.innerHTML = pageIcon(page.icon)
        const label = document.createElement('span')
        label.textContent = page.title || t('Untitled')
        a.append(ico, label)
        a.addEventListener('click', (e) => { e.preventDefault(); s.goToPage(page.id); this.toggleSidebar(false) })
        const un = document.createElement('button')
        un.className = 'sp-rowmore'
        un.type = 'button'
        un.innerHTML = ICONS.unarchive
        un.title = t('Restore to the page list')
        un.setAttribute('aria-label', t('Restore to the page list'))
        un.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation()
          s.commit(() => { const p = s.index.page.get(page.id); if (p) delete p.archived })
        })
        a.append(un)
        li.append(a)
        al.append(li)
      }
      det.append(al)
      this.sidebar.append(det)
    }

    // dropping on the empty area below the tree makes a page top-level again
    list.addEventListener('dragover', (e) => e.preventDefault())
    this.sidebar.addEventListener('drop', (e) => {
      if ((e.target as HTMLElement).closest('.sp-treelink')) return
      e.preventDefault()
      const moved = e.dataTransfer?.getData('text/bento-page')
      if (moved) this.reparentPage(moved, '')
    })
  }

  /** Re-parent a page, refusing a move that would make it its own ancestor. */
  private reparentPage(id: string, parent: string): void {
    if (id === parent) return
    for (let p: string | undefined = parent; p; p = this.store.index.page.get(p)?.parent) {
      if (p === id) { this.status(t('A page cannot contain itself')); return }
    }
    this.store.commit(() => {
      const page = this.store.index.page.get(id)
      if (!page) return
      if (parent) page.parent = parent
      else delete page.parent
    })
  }

  newPage(parent?: string): void {
    const page = newPage(t('Untitled'))
    if (parent) page.parent = parent
    this.store.commit(() => { this.store.doc.pages.push(page) })
    this.store.goToPage(page.id)
    afterPaint(() => {
      const h = this.main.querySelector<HTMLElement>('[data-page-title]')
      h?.focus()
      if (h) selectAll(h)
    })
  }

  // ---- the page -----------------------------------------------------------
  private paintPage(): void {
    const s = this.store
    const page = s.page
    this.main.innerHTML = ''
    if (!page) { this.main.append(el('p', 'sp-empty', t('This space has no pages.'))); return }

    this.painting = true
    const trail: string[] = []
    for (let p = page.parent; p; p = s.index.page.get(p)?.parent) {
      const owner = s.index.page.get(p)
      if (!owner) break
      trail.unshift(owner.id)
      if (trail.length > 4) break
    }
    const view = renderPage(page, s.doc, {
      editable: !s.readOnly && !this.reading,
      titleOf: (id) => s.index.page.get(id)?.title,
      allowRemote: (src) => this.allowedRemote.has(src),
    })
    // the icon lives beside the title, where changing it is discoverable
    const inner = view.querySelector('.sp-page-inner')
    if (inner && !s.readOnly && !this.reading) {
      const pick = document.createElement('button')
      pick.className = 'sp-pageicon'
      pick.type = 'button'
      pick.innerHTML = pageIcon(page.icon)
      pick.title = t('Change this page\'s icon')
      pick.setAttribute('aria-label', t('Change this page\'s icon'))
      pick.addEventListener('click', () => this.openIconPicker(page.id, pick))
      inner.prepend(pick)
    }

    if (trail.length) {
      const crumb = el('nav', 'sp-crumb')
      crumb.setAttribute('aria-label', t('Breadcrumb'))
      trail.forEach((id, i) => {
        if (i) crumb.append(Object.assign(document.createElement('span'), { textContent: '›' }))
        const a = document.createElement('a')
        a.href = `#p/${id}`
        a.textContent = s.index.page.get(id)?.title || t('Untitled')
        a.addEventListener('click', (e) => { e.preventDefault(); s.goToPage(id) })
        crumb.append(a)
      })
      view.querySelector('.sp-page-inner')?.prepend(crumb)
    }
    this.main.append(view)
    this.wire(view)
    view.querySelector('.sp-page-inner')?.append(this.backlinks(page.id))
    this.painting = false
  }

  /**
   * The hover gutter.
   *
   * A block editor with no visible affordances is a guessing game: nothing on
   * screen says a block can be moved or that a new one can go here. These sit
   * OUTSIDE the text column so they never reflow the prose, and only appear on
   * hover so a page at rest is just the writing.
   */
  private addGutter(node: HTMLElement, blockId: string): void {
    const g = el('div', 'sp-gutter')
    const add = document.createElement('button')
    add.className = 'sp-ghost'
    add.type = 'button'
    add.innerHTML = ICONS.plus
    add.title = t('Add a block below')
    add.setAttribute('aria-label', t('Add a block below'))
    add.addEventListener('click', () => this.insertAfter(blockId))

    const grip = document.createElement('button')
    grip.className = 'sp-ghost'
    grip.type = 'button'
    grip.draggable = true
    grip.innerHTML = ICONS.grip
    grip.title = t('Drag to move, click for block options')
    grip.setAttribute('aria-label', t('Block options'))
    grip.addEventListener('click', () => this.openSlash(blockId, grip))
    grip.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/bento-block', blockId)
      node.classList.add('sp-dragging')
    })
    grip.addEventListener('dragend', () => node.classList.remove('sp-dragging'))

    node.addEventListener('dragover', (e) => { e.preventDefault(); node.classList.add('sp-dropline') })
    node.addEventListener('dragleave', () => node.classList.remove('sp-dropline'))
    node.addEventListener('drop', (e) => {
      e.preventDefault()
      node.classList.remove('sp-dropline')
      const moved = e.dataTransfer?.getData('text/bento-block')
      if (moved && moved !== blockId) this.moveBlock(moved, blockId)
    })

    g.append(add, grip)
    node.prepend(g)
  }

  private insertAfter(blockId: string): void {
    const s = this.store
    const page = s.page
    if (!page) return
    const fresh = newBlock('p')
    const owner = s.block(blockId)
    if (owner?.parent) fresh.parent = owner.parent
    s.commit(() => {
      page.blocks.splice(page.blocks.findIndex((b) => b.id === blockId) + 1, 0, fresh)
    })
    this.paintPage()
    this.focusBlock(fresh.id)
  }

  /** Move a block (and anything nested under it) to sit after another. */
  private moveBlock(moved: string, after: string): void {
    const s = this.store
    const page = s.page
    if (!page) return
    const from = page.blocks.findIndex((b) => b.id === moved)
    if (from < 0) return
    // a subtree travels with its owner, or its children would be orphaned
    const kids: string[] = []
    const collect = (id: string) => {
      for (const b of page.blocks) if (b.parent === id) { kids.push(b.id); collect(b.id) }
    }
    collect(moved)
    if (kids.includes(after)) return // never drop a block inside its own subtree
    s.commit(() => {
      const group = [moved, ...kids].map((id) => page.blocks.find((b) => b.id === id)!).filter(Boolean)
      for (const b of group) page.blocks.splice(page.blocks.indexOf(b), 1)
      const at = page.blocks.findIndex((b) => b.id === after) + 1
      page.blocks.splice(at, 0, ...group)
    })
    this.paintPage()
  }

  /** Attach behaviour to a freshly painted page. */
  private wire(view: HTMLElement): void {
    const s = this.store

    const title = view.querySelector<HTMLElement>('[data-page-title]')
    if (title) {
      title.dataset.ph = t('Untitled')
      if (!title.textContent?.trim()) title.dataset.empty = '1'
      title.addEventListener('input', () => { if (title.textContent?.trim()) delete title.dataset.empty; else title.dataset.empty = '1' })
    }
    title?.addEventListener('input', () => {
      if (this.painting) return
      const id = title.dataset.pageTitle!
      s.runEdit(`title:${id}`, () => {
        const p = s.index.page.get(id)
        if (p) p.title = title.textContent ?? ''
      })
      this.paintTreeSoon()
    })

    for (const node of view.querySelectorAll<HTMLElement>('[data-block-id]')) {
      if (!s.readOnly && !this.reading) this.addGutter(node, node.dataset.blockId!)
    }

    for (const host of view.querySelectorAll<HTMLElement>('[data-edit]')) {
      const id = host.dataset.edit!
      host.dataset.ph = t('Type / for blocks, [[ to link a page')
      host.addEventListener('input', () => {
        if (this.painting) return
        delete host.dataset.empty
        s.runEdit(id, () => {
          const b = s.block(id)
          if (b) b.html = host.innerHTML
        })
        this.autoformat(id, host)
      })
      host.addEventListener('blur', () => {
        if (this.painting) return
        s.endRun()
        const b = s.block(id)
        if (b && b.html !== undefined) {
          const clean = canonicalize(b.html)
          if (clean !== b.html) { b.html = clean; host.innerHTML = clean }
        }
      })
    }

    for (const box of view.querySelectorAll<HTMLInputElement>('.sp-check')) {
      box.addEventListener('change', () => {
        const id = (box.closest('[data-block-id]') as HTMLElement).dataset.blockId!
        s.commit(() => { const b = s.block(id); if (b) b.done = box.checked }, { structure: false })
        box.closest('[data-block-id]')!.classList.toggle('sp-done', box.checked)
      })
    }

    for (const tw of view.querySelectorAll<HTMLElement>('.sp-twist')) {
      tw.addEventListener('click', () => {
        const id = (tw.closest('[data-block-id]') as HTMLElement).dataset.blockId!
        s.commit(() => { const b = s.block(id); if (b) b.open = !b.open })
        this.paintPage()
      })
    }

    // "Load this image" — the reader's consent to contact one remote host.
    // NOT a commit: nothing about the document changed, so this must not touch
    // undo, the dirty flag or autosave. It is view state, and it dies with the
    // session (see allowedRemote).
    for (const btn of view.querySelectorAll<HTMLElement>('[data-load-remote]')) {
      btn.addEventListener('click', (e) => {
        e.preventDefault()
        this.allowedRemote.add(btn.dataset.loadRemote!)
        this.paintPage()
      })
    }

    // an image can arrive by paste or by drop, not only through a menu
    view.addEventListener('paste', (e) => {
      const cur = this.blockAt(document.activeElement)
      if (e.clipboardData?.files?.length) {
        e.preventDefault()
        void this.imageFromTransfer(e.clipboardData, cur?.id)
      }
    })
    view.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); view.classList.add('sp-filedrop') }
    })
    view.addEventListener('dragleave', () => view.classList.remove('sp-filedrop'))
    view.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      view.classList.remove('sp-filedrop')
      const near = (e.target as HTMLElement)?.closest?.('[data-block-id]') as HTMLElement | null
      void this.imageFromTransfer(e.dataTransfer, near?.dataset.blockId)
    })

    for (const fig of view.querySelectorAll<HTMLElement>('.sp-b-image')) {
      const id = fig.dataset.blockId!
      const b = s.block(id)
      const tools = el('div', 'sp-imgtools')
      const sizeBtn = document.createElement('button')
      sizeBtn.className = 'sp-btn'
      sizeBtn.type = 'button'
      sizeBtn.textContent = `${b?.width ?? 100}%`
      sizeBtn.title = t('Width in the text column')
      sizeBtn.addEventListener('click', () => {
        const steps = [100, 75, 50, 33]
        const cur = Number(b?.width ?? 100)
        const next = steps[(steps.indexOf(cur) + 1) % steps.length]
        s.commit(() => { const bb = s.block(id); if (bb) bb.width = next })
        this.paintPage()
      })
      tools.append(sizeBtn)
      // a re-encoded image says so, and offers the untouched bytes back
      if (b && b.original === false) {
        const badge = document.createElement('button')
        badge.className = 'sp-btn sp-badge'
        badge.type = 'button'
        badge.textContent = t('Resized')
        badge.title = t('This image was resized to keep the file small. Click to replace it with the original.')
        badge.addEventListener('click', () => void this.pickImage(id))
        tools.append(badge)
      }
      fig.append(tools)
    }

    // intra-space links navigate without leaving the document
    view.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a')
      if (!a) return
      const href = a.getAttribute('href') ?? ''
      if (href.startsWith('#p/')) { e.preventDefault(); s.goToPage(href.slice(3)) }
    })
  }

  private treeTimer: ReturnType<typeof setTimeout> | undefined
  private paintTreeSoon(): void {
    clearTimeout(this.treeTimer)
    this.treeTimer = setTimeout(() => this.paintTree(), 250)
  }

  /** What links here — derived, never stored. */
  private backlinks(pageId: string): HTMLElement {
    const s = this.store
    const refs = s.index.backlinks.get(pageId) ?? []
    const box = el('section', 'sp-backlinks')
    if (!refs.length) return box
    box.append(el('h2', 'sp-backlinks-h', t('Linked from')))
    const seen = new Set<string>()
    const ul = el('ul', 'sp-backlink-list')
    for (const r of refs) {
      if (seen.has(r.pageId)) continue
      seen.add(r.pageId)
      const from = s.index.page.get(r.pageId)
      if (!from) continue
      const li = document.createElement('li')
      const a = document.createElement('a')
      a.href = `#p/${from.id}`
      a.textContent = from.title || t('Untitled')
      a.addEventListener('click', (e) => { e.preventDefault(); s.goToPage(from.id) })
      const snippet = textOf(s.index.block.get(r.blockId)?.block.html).slice(0, 120)
      li.append(a)
      if (snippet) li.append(el('span', 'sp-snippet', snippet))
      ul.append(li)
    }
    box.append(ul)
    return box
  }

  // ---- editing ------------------------------------------------------------
  private blockAt(node: Node | null): { id: string; host: HTMLElement } | null {
    const host = (node instanceof HTMLElement ? node : node?.parentElement)?.closest<HTMLElement>('[data-edit]')
    return host ? { id: host.dataset.edit!, host } : null
  }

  private focused(): { id: string; host: HTMLElement } | null {
    return this.blockAt(document.activeElement)
  }

  /** Markdown prefixes convert the block as they are typed. */
  private autoformat(id: string, host: HTMLElement): void {
    const text = host.textContent ?? ''
    for (const [re, type, extra] of AUTOFORMAT) {
      if (!re.test(text)) continue
      const s = this.store
      const b = s.block(id)
      if (!b || b.type === type) return
      s.commit(() => { b.type = type; b.html = ''; extra(b) })
      this.paintPage()
      this.focusBlock(id)
      return
    }
  }

  private focusBlock(id: string, atEnd = true): void {
    afterPaint(() => {
      const host = this.main.querySelector<HTMLElement>(`[data-edit="${CSS.escape(id)}"]`)
      if (!host) return
      host.focus()
      if (atEnd) caretToEnd(host)
    })
  }

  private onKey(e: KeyboardEvent): void {
    const s = this.store
    const mod = (e as any)[CTRL] as boolean

    if (mod && e.key.toLowerCase() === 'k' && !e.shiftKey) { e.preventDefault(); this.openSearch(); return }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); this.onSave?.(); return }
    if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); this.openPrint(); return }
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); this.openFind(); return }
    if (mod && e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); this.newPage(); return }
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) s.redo(); else s.undo()
      this.paintPage(); this.paintTree()
      return
    }
    if (e.key === 'Escape' && this.reading && !this.overlay) { e.preventDefault(); this.toggleReading(false); return }
    if (this.overlay) return // the overlay owns the keyboard while it is open

    const cur = this.focused()
    if (!cur) return
    const b = s.block(cur.id)
    if (!b) return

    // native undo must never diverge from the store's history
    if (mod && (e.key.toLowerCase() === 'y')) { e.preventDefault(); s.redo(); this.paintPage(); return }

    if (e.key === 'Enter' && !e.shiftKey && b.type !== 'code') {
      e.preventDefault()
      this.splitBlock(cur.id, cur.host)
      return
    }
    if (e.key === 'Backspace' && atStart(cur.host)) {
      const empty = !(cur.host.textContent ?? '').trim()
      if (b.type !== 'p' && empty) { e.preventDefault(); this.setType(cur.id, 'p'); return }
      e.preventDefault()
      this.mergeBack(cur.id)
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      this.indent(cur.id, !e.shiftKey)
      return
    }
    if (e.key === '/' && !(cur.host.textContent ?? '').trim()) {
      // a slash on an empty block opens the block menu
      setTimeout(() => this.openSlash(cur.id), 0)
      return
    }
    if (e.key === '[' && cur.host.textContent?.endsWith('[')) {
      setTimeout(() => this.openPagePicker(cur.id, cur.host), 0)
      return
    }
    if (mod && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
      e.preventDefault()
      document.execCommand(({ b: 'bold', i: 'italic', u: 'underline' } as any)[e.key.toLowerCase()])
      s.runEdit(cur.id, () => { const bb = s.block(cur.id); if (bb) bb.html = cur.host.innerHTML })
      return
    }
  }

  private splitBlock(id: string, host: HTMLElement): void {
    const s = this.store
    const b = s.block(id)
    if (!b) return
    const [before, after] = splitAtCaret(host)
    const fresh = newBlock(b.type === 'h1' || b.type === 'h2' || b.type === 'h3' ? 'p' : b.type, { html: after })
    if (b.type === 'todo') fresh.done = false
    if (b.parent) fresh.parent = b.parent
    s.commit(() => {
      b.html = before
      const page = s.page!
      page.blocks.splice(page.blocks.indexOf(b) + 1, 0, fresh)
    })
    this.paintPage()
    this.focusBlock(fresh.id, false)
  }

  private mergeBack(id: string): void {
    const s = this.store
    const page = s.page
    if (!page) return
    const i = page.blocks.findIndex((x) => x.id === id)
    if (i <= 0) return
    const prev = page.blocks[i - 1]
    const b = page.blocks[i]
    if (prev.type === 'divider') { s.commit(() => { page.blocks.splice(i - 1, 1) }); this.paintPage(); this.focusBlock(id); return }
    const at = (prev.html ?? '').length
    s.commit(() => {
      prev.html = (prev.html ?? '') + (b.html ?? '')
      // a merged-away parent would orphan its children — re-home them
      for (const child of page.blocks) if (child.parent === b.id) child.parent = prev.id
      page.blocks.splice(i, 1)
    })
    this.paintPage()
    afterPaint(() => {
      const host = this.main.querySelector<HTMLElement>(`[data-edit="${CSS.escape(prev.id)}"]`)
      if (host) { host.focus(); caretToOffset(host, at) }
    })
  }

  /** Tab sets `parent` to the previous sibling — one field write. */
  private indent(id: string, deeper: boolean): void {
    const s = this.store
    const page = s.page
    if (!page) return
    const i = page.blocks.findIndex((x) => x.id === id)
    const b = page.blocks[i]
    if (!b) return
    s.commit(() => {
      if (!deeper) {
        if (!b.parent) return
        const owner = page.blocks.find((x) => x.id === b.parent)
        if (owner?.parent) b.parent = owner.parent
        else delete b.parent
        return
      }
      // the nearest preceding block at the same level becomes the owner
      for (let j = i - 1; j >= 0; j--) {
        if (page.blocks[j].parent === b.parent) { b.parent = page.blocks[j].id; return }
      }
    })
    this.paintPage()
    this.focusBlock(id)
  }

  setType(id: string, type: string): void {
    this.store.commit(() => {
      const b = this.store.block(id)
      if (!b) return
      b.type = type
      if (type === 'todo' && b.done === undefined) b.done = false
      if (type === 'toggle' && b.open === undefined) b.open = true
    })
    this.paintPage()
    this.focusBlock(id)
  }

  // ---- overlays -----------------------------------------------------------
  private openOverlay(title: string, build: (body: HTMLElement, close: () => void) => void): void {
    this.closeOverlay()
    const back = el('div', 'sp-overlay')
    const card = el('div', 'sp-card')
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-label', title)
    const close = () => this.closeOverlay()
    build(card, close)
    back.append(card)
    back.addEventListener('mousedown', (e) => { if (e.target === back) close() })
    document.body.append(back)
    this.overlay = back
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close() } }
    back.addEventListener('keydown', onEsc)
    card.querySelector<HTMLElement>('input,button,[tabindex]')?.focus()
  }

  private closeOverlay(): void {
    this.overlay?.remove()
    this.overlay = null
  }

  /** Anchor a popover to a rect, kept inside the viewport. */

  /** ⌘K — search every page, including collapsed toggles and archived pages. */
  openSearch(): void {
    const s = this.store
    this.openOverlay(t('Search'), (card, close) => {
      const input = document.createElement('input')
      input.className = 'sp-find'
      input.placeholder = t('Search all pages…')
      const results = el('ul', 'sp-results')
      const run = () => {
        const q = input.value.trim().toLowerCase()
        results.innerHTML = ''
        if (!q) return
        let n = 0
        for (const p of s.doc.pages) {
          const hits: string[] = []
          if (p.title.toLowerCase().includes(q)) hits.push(p.title)
          for (const b of p.blocks) {
            const text = textOf(b.html)
            if (text.toLowerCase().includes(q)) hits.push(text)
            if (hits.length > 2) break
          }
          if (!hits.length) continue
          if (++n > 30) break
          const li = document.createElement('li')
          const a = document.createElement('button')
          a.className = 'sp-result'
          a.innerHTML =
            `<span class="sp-result-ico">${ICONS.page}</span>` +
            `<span class="sp-result-txt"><strong>${escapeHtml(p.title || t('Untitled'))}` +
            (p.archived ? ` <em class="sp-arch">${t('archived')}</em>` : '') + `</strong>` +
            `<span>${escapeHtml(hits.slice(0, 2).join(' · ').slice(0, 140))}</span></span>`
          a.addEventListener('click', () => { close(); s.goToPage(p.id) })
          li.append(a)
          results.append(li)
        }
        if (!results.childElementCount) results.append(el('li', 'sp-noresult', t('Nothing found')))
      }
      input.addEventListener('input', run)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') results.querySelector<HTMLElement>('.sp-result')?.click()
      })
      card.append(el('h2', 'sp-card-h', t('Search this space')), input, results)
    })
  }

  /**
   * The block menu, anchored where you are.
   *
   * A centred modal for "turn this line into a heading" loses the thing you
   * were pointing at. This opens beside the caret (or the gutter button that
   * summoned it), is driven entirely by the keyboard, and filters as you type
   * so `/h2` reaches a heading without the hand leaving the keys.
   */
  private openSlash(blockId: string, anchor?: HTMLElement): void {
    this.closeOverlay()
    const pop = el('div', 'sp-pop')
    pop.setAttribute('role', 'listbox')
    const find = document.createElement('input')
    find.className = 'sp-find'
    find.placeholder = t('Filter blocks…')
    const list = el('ul', 'sp-results')
    pop.append(find, list)

    let items = SLASH_ITEMS
    let sel = 0
    const commit = (item: typeof SLASH_ITEMS[number]) => {
      this.closeOverlay()
      const blk = this.store.block(blockId)
      // the "/" that opened the menu is a command, not content
      if (blk && (blk.html ?? '').trim() === '/') blk.html = ''
      if (item.type === 'pagelink') this.insertPageCard(blockId)
      else this.setType(blockId, item.type)
    }
    const paint = () => {
      list.innerHTML = ''
      items.forEach((item, i) => {
        const li = document.createElement('li')
        const b = document.createElement('button')
        b.className = 'sp-result' + (i === sel ? ' sp-sel' : '')
        b.type = 'button'
        b.setAttribute('role', 'option')
        b.innerHTML =
          `<span class="sp-result-ico">${ICONS[item.icon]}</span>` +
          `<span class="sp-result-txt"><strong>${escapeHtml(t(item.label))}</strong>` +
          `<span>${escapeHtml(t(item.hint))}</span></span>`
        b.addEventListener('click', () => commit(item))
        li.append(b)
        list.append(li)
      })
      if (!items.length) list.append(el('li', 'sp-noresult', t('No block matches')))
    }
    find.addEventListener('input', () => {
      const q = find.value.trim().toLowerCase()
      items = SLASH_ITEMS.filter((i) => t(i.label).toLowerCase().includes(q) || i.type.includes(q))
      sel = 0
      paint()
    })
    find.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); paint() }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paint() }
      else if (e.key === 'Enter') { e.preventDefault(); if (items[sel]) commit(items[sel]) }
      else if (e.key === 'Escape') { e.preventDefault(); this.closeOverlay(); this.focusBlock(blockId) }
    })
    paint()

    document.body.append(pop)
    this.overlay = pop
    place(pop, anchor ?? caretRect())
    find.focus()

    // clicking anywhere else dismisses, but not the first click that opened it
    setTimeout(() => {
      const away = (ev: MouseEvent) => {
        if (!pop.contains(ev.target as Node)) { this.closeOverlay(); document.removeEventListener('mousedown', away) }
      }
      document.addEventListener('mousedown', away)
    }, 0)
  }

  private insertPageCard(blockId: string): void {
    this.openPagePicker(blockId, null, (pageId) => {
      this.store.commit(() => {
        const b = this.store.block(blockId)
        if (b) { b.type = 'pagelink'; b.page = pageId; b.html = '' }
      })
      this.paintPage()
    })
  }

  /** `[[` — pick a page, or make one, and link it inline. */
  private openPagePicker(blockId: string, host: HTMLElement | null, then?: (pageId: string) => void): void {
    const s = this.store
    this.openOverlay(t('Link to page'), (card, close) => {
      const input = document.createElement('input')
      input.className = 'sp-find'
      input.placeholder = t('Find or create a page…')
      const list = el('ul', 'sp-results')
      const choose = (pageId: string, title: string) => {
        close()
        if (then) { then(pageId); return }
        if (!host) return
        // the two "[" that opened the picker are not content
        const html = (host.innerHTML ?? '').replace(/\[?\[$/, '')
        const link = `<a href="#p/${pageId}">${escapeHtml(title)}</a>&nbsp;`
        s.commit(() => { const b = s.block(blockId); if (b) b.html = sanitizeInline(html + link) })
        this.paintPage()
        this.focusBlock(blockId)
      }
      const run = () => {
        const q = input.value.trim().toLowerCase()
        list.innerHTML = ''
        for (const p of s.doc.pages) {
          if (q && !p.title.toLowerCase().includes(q)) continue
          const li = document.createElement('li')
          const b = document.createElement('button')
          b.className = 'sp-result'
          b.type = 'button'
          b.innerHTML =
            `<span class="sp-result-ico">${ICONS.page}</span>` +
            `<span class="sp-result-txt"><strong>${escapeHtml(p.title || t('Untitled'))}</strong></span>`
          b.addEventListener('click', () => choose(p.id, p.title || t('Untitled')))
          li.append(b)
          list.append(li)
          if (list.childElementCount > 20) break
        }
        if (input.value.trim()) {
          const li = document.createElement('li')
          const b = document.createElement('button')
          b.className = 'sp-result sp-new'
          b.type = 'button'
          b.innerHTML =
            `<span class="sp-result-ico">${ICONS.plus}</span>` +
            `<span class="sp-result-txt"><strong>${escapeHtml(t('Create “{name}”', { name: input.value.trim() }))}</strong></span>`
          b.addEventListener('click', () => {
            const page = newPage(input.value.trim())
            s.commit(() => { s.doc.pages.push(page) })
            choose(page.id, page.title)
          })
          li.append(b)
          list.append(li)
        }
      }
      input.addEventListener('input', run)
      card.append(input, list)
      run()
    })
  }

  /** Pick a page icon from the stylised set. */
  private openIconPicker(pageId: string, anchor: HTMLElement): void {
    this.closeOverlay()
    const pop = el('div', 'sp-pop sp-iconpop')
    for (const name of PAGE_ICONS) {
      const b = document.createElement('button')
      b.className = 'sp-iconopt'
      b.type = 'button'
      b.innerHTML = ICONS[name]
      b.title = name
      b.setAttribute('aria-label', name)
      b.addEventListener('click', () => {
        this.closeOverlay()
        this.store.commit(() => {
          const p = this.store.index.page.get(pageId)
          if (p) p.icon = name
        })
        this.paintPage()
      })
      pop.append(b)
    }
    document.body.append(pop)
    this.overlay = pop
    place(pop, anchor)
    setTimeout(() => {
      const away = (ev: MouseEvent) => {
        if (!pop.contains(ev.target as Node)) { this.closeOverlay(); document.removeEventListener('mousedown', away) }
      }
      document.addEventListener('mousedown', away)
    }, 0)
  }

  /** Rename, archive, or delete one page. */
  private openPageMenu(pageId: string, anchor: HTMLElement): void {
    const s = this.store
    const page = s.index.page.get(pageId)
    if (!page) return
    this.closeOverlay()
    const pop = el('div', 'sp-pop')
    pop.setAttribute('role', 'menu')

    pop.append(this.menuItem('edit', t('Rename'), '', () => {
      this.closeOverlay()
      s.goToPage(pageId)
      afterPaint(() => {
        const h = this.main.querySelector<HTMLElement>('[data-page-title]')
        if (h) { h.focus(); selectAll(h) }
      })
    }))

    pop.append(this.menuItem('plus', t('New page inside'), '', () => {
      this.closeOverlay()
      this.newPage(pageId)
    }))

    pop.append(this.menuItem(page.archived ? 'unarchive' : 'archive',
      page.archived ? t('Restore to the page list') : t('Archive'),
      page.archived ? '' : t('Out of the sidebar, still searchable and linkable'), () => {
        this.closeOverlay()
        s.commit(() => {
          const p = s.index.page.get(pageId)
          if (!p) return
          if (p.archived) delete p.archived
          else p.archived = true
        })
      }))

    pop.append(this.menuItem('trash', t('Delete…'), t('Links to it become dead'), () => {
      this.closeOverlay()
      this.deletePage(pageId)
    }))

    document.body.append(pop)
    this.overlay = pop
    place(pop, anchor)
    setTimeout(() => {
      const away = (ev: MouseEvent) => {
        if (!pop.contains(ev.target as Node)) { this.closeOverlay(); document.removeEventListener('mousedown', away) }
      }
      document.addEventListener('mousedown', away)
    }, 0)
  }

  /**
   * Delete a page.
   *
   * Its children are re-homed to ITS parent rather than deleted with it —
   * removing a middle page should not silently take a subtree the author was
   * not looking at. Inbound links are counted in the confirmation, because
   * "this will break 4 links" is the fact that decides it.
   */
  private deletePage(pageId: string): void {
    const s = this.store
    const page = s.index.page.get(pageId)
    if (!page) return
    if (s.doc.pages.length <= 1) { this.status(t('A space needs at least one page')); return }
    const inbound = (s.index.backlinks.get(pageId) ?? []).length
    const kids = s.doc.pages.filter((p) => p.parent === pageId).length
    const parts = [t('Delete “{name}”?', { name: page.title || t('Untitled') })]
    if (inbound) parts.push(t('{n} link(s) to it will stop working.', { n: inbound }))
    if (kids) parts.push(t('{n} page(s) inside it move up a level.', { n: kids }))
    if (!confirm(parts.join('\n'))) return
    s.commit(() => {
      for (const p of s.doc.pages) if (p.parent === pageId) {
        if (page.parent) p.parent = page.parent
        else delete p.parent
      }
      s.doc.pages.splice(s.doc.pages.findIndex((p) => p.id === pageId), 1)
      if (s.doc.home === pageId) delete s.doc.home
    })
    this.repaint()
  }

  // ---- images --------------------------------------------------------------
  /** Choose a file and put it in the document. */
  async pickImage(blockId: string): Promise<void> {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file) void this.placeImage(blockId, file)
    })
    input.click()
  }

  /**
   * Embed one image.
   *
   * Everything slow and asynchronous — reading, decoding, re-encoding, hashing
   * — happens BEFORE the commit, so the bytes and the reference land in ONE
   * synchronous mutation. That is what makes an image insert a single undo
   * step instead of a half-inserted block if something throws in between.
   */
  async placeImage(
    blockId: string | null,
    file: File | Blob,
    opts: { keepOriginal?: boolean; insertAfter?: string | null } = {},
  ): Promise<void> {
    const s = this.store
    this.status(t('Reading image…'))
    let prepared
    try {
      prepared = opts.keepOriginal
        ? { dataUri: await blobToDataUri(file), w: 0, h: 0, original: true, wasBytes: file.size }
        : await prepareImage(file)
    } catch {
      this.status(t('That file could not be read as an image'))
      return
    }

    if (prepared.dataUri.length > IMAGE_EMBED_BUDGET) {
      const ok = confirm(t(
        'This image is {size} and travels inside the file, making it that much bigger for everyone you send it to. Embed it anyway?',
        { size: humanBytes(prepared.dataUri.length) },
      ))
      if (!ok) { this.status(''); return }
    }

    const ref = await internAsset(s.doc, prepared.dataUri)
    const fill = (b: Block) => {
      b.type = 'image'
      b.src = ref
      b.html = ''
      if (prepared.w) { b.w = prepared.w; b.h = prepared.h }
      if (!prepared.original) b.original = false
      else delete b.original
    }
    // ONE commit, whether the block already exists or is being created here.
    // Creating it in a separate commit would make an inserted image take TWO
    // undos, the second of which removes a block the author never saw.
    s.commit(() => {
      if (blockId) { const b = s.block(blockId); if (b) fill(b) ; return }
      const page = s.page
      if (!page) return
      const fresh = newBlock('image')
      fill(fresh)
      const at = opts.insertAfter ? page.blocks.findIndex((b) => b.id === opts.insertAfter) + 1 : page.blocks.length
      page.blocks.splice(at < 1 ? page.blocks.length : at, 0, fresh)
    })
    this.paintPage()
    this.status(prepared.original
      ? t('Image added ({size})', { size: humanBytes(prepared.dataUri.length) })
      : t('Image added, resized to fit ({from} → {to})', {
        from: humanBytes(prepared.wasBytes), to: humanBytes(prepared.dataUri.length),
      }))
  }

  /** Drop or paste an image straight onto the page. */
  private async imageFromTransfer(dt: DataTransfer | null, afterId?: string): Promise<boolean> {
    const file = [...(dt?.files ?? [])].find((f) => f.type.startsWith('image/'))
      ?? [...(dt?.items ?? [])].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile())[0]
    if (!file) return false
    if (!this.store.page) return false
    await this.placeImage(null, file, { insertAfter: afterId ?? null })
    return true
  }

  // ---- find and replace ----------------------------------------------------
  /**
   * ⌘F is OURS, not the browser's.
   *
   * Native find cannot see a collapsed toggle's body, cannot see a page that is
   * not currently rendered, and cannot see an archived page at all — which is
   * most of a space. So this searches the MODEL, jumps to each hit, expands
   * whatever was folded around it, and can replace across every page in one
   * undoable step.
   */
  openFind(): void {
    const s = this.store
    document.querySelector('.sp-findbar')?.remove()
    const bar = el('div', 'sp-findbar')
    bar.setAttribute('role', 'search')

    const q = document.createElement('input')
    q.className = 'sp-find'
    q.placeholder = t('Find in this space…')
    q.setAttribute('aria-label', t('Find'))

    const rep = document.createElement('input')
    rep.className = 'sp-find'
    rep.placeholder = t('Replace with…')
    rep.setAttribute('aria-label', t('Replace with'))

    const count = el('span', 'sp-findcount')
    const mk = (icon: IconName, label: string, fn: () => void) => {
      const b = document.createElement('button')
      b.className = 'sp-btn'
      b.type = 'button'
      b.innerHTML = ICONS[icon]
      b.title = label
      b.setAttribute('aria-label', label)
      b.addEventListener('click', fn)
      return b
    }

    // ONE ENTRY PER OCCURRENCE, not per block. The readout, the stepper and the
    // replace-all confirmation then all quote the same number — and it is the
    // number of things that will actually change, because it comes from the
    // routine that changes them (countOutsideTags / replaceOutsideTags share
    // mapTextChunks). Counting blocks meant "2 found" above a dialog offering
    // to replace 2, which then replaced 4.
    let hits: Array<{ pageId: string; blockId: string }> = []
    let at = -1

    const scan = () => {
      const needle = q.value
      hits = []
      at = -1
      if (needle) {
        for (const p of s.doc.pages) {
          for (const b of p.blocks) {
            const n = countOutsideTags(b.html, needle)
            for (let i = 0; i < n; i++) hits.push({ pageId: p.id, blockId: b.id })
          }
        }
      }
      count.textContent = hits.length ? t('{n} found', { n: hits.length }) : (needle ? t('none') : '')
    }

    const jump = (dir: 1 | -1) => {
      if (!hits.length) return
      at = (at + dir + hits.length) % hits.length
      const hit = hits[at]
      count.textContent = t('{i} of {n}', { i: at + 1, n: hits.length })

      // Unfold FIRST, then navigate — one paint, and no dependence on when a
      // repaint happens to land. Doing it the other way round meant reveal ran
      // against whichever page the store had reached by the next frame, and
      // the fold stayed shut.
      const opened = this.revealBlock(hit.pageId, hit.blockId)
      if (hit.pageId !== s.pageId) s.goToPage(hit.pageId)
      else if (opened) this.paintPage()

      afterPaint(() => {
        const node = this.main.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(hit.blockId)}"]`)
        node?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        // two occurrences in one block are two stops: restart the flash, or
        // the second step looks like the stepper did nothing
        node?.classList.remove('sp-hit')
        void node?.offsetWidth
        node?.classList.add('sp-hit')
        setTimeout(() => node?.classList.remove('sp-hit'), 1400)
      })
    }

    const replaceAll = () => {
      const needle = q.value
      if (!needle || !hits.length) return
      if (!confirm(t('Replace {n} occurrence(s) across the whole space?', { n: hits.length }))) return
      // ONE commit for the whole sweep: a replace-all a user has to undo forty
      // times is not undoable in any sense they care about
      s.commit(() => {
        for (const p of s.doc.pages) {
          for (const b of p.blocks) {
            if (!countOutsideTags(b.html, needle)) continue
            b.html = replaceOutsideTags(b.html!, needle, rep.value)
          }
        }
      })
      this.repaint()
      scan()
      this.status(t('Replaced'))
    }

    q.addEventListener('input', scan)
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); jump(e.shiftKey ? -1 : 1) }
      if (e.key === 'Escape') { e.preventDefault(); bar.remove() }
    })
    rep.addEventListener('keydown', (e) => { if (e.key === 'Escape') bar.remove() })

    bar.append(q, mk('arrowUp', t('Previous (⇧⏎)'), () => jump(-1)),
      mk('arrowDown', t('Next (⏎)'), () => jump(1)), count,
      rep, mk('replace', t('Replace all'), replaceAll),
      mk('close', t('Close'), () => bar.remove()))
    this.root.append(bar)
    q.focus()
    scan()
  }

  /**
   * Open every toggle between a block and the top of its page, so a hit is
   * actually visible when we arrive at it.
   *
   * Takes the page id EXPLICITLY rather than reading the current page: the
   * caller may not have navigated yet, and depending on that ordering is what
   * broke this the first time. Returns whether anything changed, so the caller
   * can decide whether a repaint is owed.
   */
  private revealBlock(pageId: string, blockId: string): boolean {
    const s = this.store
    const page = s.index.page.get(pageId)
    if (!page) return false
    let changed = false
    let cur = page.blocks.find((b) => b.id === blockId)
    const guard = new Set<string>()
    while (cur?.parent && !guard.has(cur.parent)) {
      guard.add(cur.parent)
      const owner = page.blocks.find((b) => b.id === cur!.parent)
      if (!owner) break
      if (owner.type === 'toggle' && !owner.open) { owner.open = true; changed = true }
      cur = owner
    }
    // a fold opened to show a search hit is a VIEW change, not an edit: it is
    // mutated directly rather than through commit(), so searching never lands
    // on the undo stack or marks the document modified
    return changed
  }

  // ---- print ---------------------------------------------------------------
  /**
   * Printing is the ONLY export-to-PDF path, so it is a contract rather than a
   * stylesheet: what goes in, in what order, and what happens to the things a
   * screen can hide.
   *
   * Collapsed toggles print EXPANDED, always. Silently omitting content from a
   * printed handbook is a data-loss-shaped bug — the reader has no way to know
   * a paragraph was folded away.
   */
  openPrint(): void {
    const s = this.store
    this.openOverlay(t('Print'), (card, close) => {
      card.append(el('h2', 'sp-card-h', t('Print or save as PDF')))

      const scope = document.createElement('div')
      scope.className = 'sp-choices'
      let whole = true
      const choice = (label: string, hint: string, on: boolean, pick: () => void) => {
        const b = document.createElement('button')
        b.className = 'sp-choice' + (on ? ' sp-sel' : '')
        b.type = 'button'
        b.innerHTML = `<strong>${escapeHtml(label)}</strong><span>${escapeHtml(hint)}</span>`
        b.addEventListener('click', () => {
          pick()
          for (const o of scope.querySelectorAll('.sp-choice')) o.classList.remove('sp-sel')
          b.classList.add('sp-sel')
        })
        return b
      }
      const pageCount = s.doc.pages.filter((p) => !p.archived).length
      scope.append(
        choice(t('The whole space'), t('{n} pages, in sidebar order, with a contents page', { n: pageCount }), true, () => { whole = true }),
        choice(t('This page only'), s.page?.title || t('Untitled'), false, () => { whole = false }),
      )
      card.append(scope)

      const opts = document.createElement('div')
      opts.className = 'sp-optlist'
      const check = (label: string, hint: string, on: boolean) => {
        const l = document.createElement('label')
        l.className = 'sp-opt'
        const i = document.createElement('input')
        i.type = 'checkbox'
        i.checked = on
        l.append(i, Object.assign(document.createElement('span'), {
          innerHTML: `<strong>${escapeHtml(label)}</strong><span>${escapeHtml(hint)}</span>`,
        }))
        opts.append(l)
        return i
      }
      const wantArchived = check(t('Include archived pages'), t('Off by default — they were archived for a reason'), false)
      const wantContents = check(t('Contents page'), t('A list of every page, in order'), true)
      card.append(opts)

      const note = document.createElement('p')
      note.className = 'sp-note'
      note.textContent = t('Collapsed toggles always print open. Your browser\'s print dialog has the "Save as PDF" option.')
      card.append(note)

      const go = document.createElement('button')
      go.className = 'sp-btn sp-primary'
      go.textContent = t('Print…')
      go.addEventListener('click', () => {
        close()
        this.printNow({ whole, archived: wantArchived.checked, contents: wantContents.checked })
      })
      card.append(go)
    })
  }

  /**
   * Build a print-only rendering, print it, and take it away again.
   *
   * The screen shows ONE page; print needs all of them, so this renders a
   * separate tree rather than trying to make the editor's DOM serve both. It
   * is removed in `afterprint`, so nothing about the editor is left changed.
   */
  private printNow(opts: { whole: boolean; archived: boolean; contents: boolean }): void {
    const s = this.store
    const host = el('div', 'sp-printroot')
    host.style.direction = 'ltr'

    const pages = opts.whole
      ? s.tree().map((n) => n.page).filter((p) => opts.archived || !p.archived)
      : (s.page ? [s.page] : [])

    if (opts.whole && opts.contents) {
      const toc = el('section', 'sp-toc')
      toc.append(el('h1', 'sp-toc-h', s.doc.title || t('Contents')))
      const ul = el('ul', 'sp-toc-list')
      for (const { page, depth } of s.tree()) {
        if (!opts.archived && page.archived) continue
        const li = document.createElement('li')
        li.style.paddingInlineStart = `${depth * 16}px`
        li.textContent = page.title || t('Untitled')
        ul.append(li)
      }
      toc.append(ul)
      host.append(toc)
    }

    for (const page of pages) {
      host.append(renderPage(page, s.doc, {
        editable: false, forceOpen: true,
        titleOf: (id) => s.index.page.get(id)?.title,
        allowRemote: (src) => this.allowedRemote.has(src),
      }))
    }

    document.body.append(host)
    document.body.classList.add('sp-printing')
    const cleanup = () => {
      host.remove()
      document.body.classList.remove('sp-printing')
      window.removeEventListener('afterprint', cleanup)
    }
    window.addEventListener('afterprint', cleanup)
    // some engines return from print() before afterprint fires
    setTimeout(() => { if (document.body.contains(host)) cleanup() }, 60000)
    print()
  }

  private exportMarkdown(): void {
    this.onSaveAs?.('__markdown')
  }

  private async saveAs(suffix: string): Promise<void> {
    this.onSaveAs?.(suffix)
  }

  // ---- routing ------------------------------------------------------------
  private fromHash(): void {
    const m = location.hash.match(/^#p\/(.+)$/)
    if (m && this.store.index.page.has(m[1])) this.store.goToPage(m[1], { push: false })
  }

  repaint(): void { this.paintTree(); this.paintPage() }
}

// ---- small dom helpers ------------------------------------------------------
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  n.className = cls
  if (text) n.textContent = text
  return n
}

function iconBtn(name: IconName, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'sp-btn'
  b.type = 'button'
  b.innerHTML = ICONS[name]
  b.title = label
  b.setAttribute('aria-label', label)
  b.addEventListener('click', onClick)
  return b
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function atStart(host: HTMLElement): boolean {
  const sel = getSelection()
  if (!sel || !sel.rangeCount) return false
  const r = sel.getRangeAt(0)
  if (!r.collapsed) return false
  const probe = r.cloneRange()
  probe.selectNodeContents(host)
  probe.setEnd(r.startContainer, r.startOffset)
  return probe.toString().length === 0
}

function caretToEnd(host: HTMLElement): void {
  const r = document.createRange()
  r.selectNodeContents(host)
  r.collapse(false)
  const sel = getSelection()
  sel?.removeAllRanges()
  sel?.addRange(r)
}

function caretToOffset(host: HTMLElement, offset: number): void {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  let seen = 0
  let node: Node | null
  while ((node = walker.nextNode())) {
    const len = node.textContent?.length ?? 0
    if (seen + len >= offset) {
      const r = document.createRange()
      r.setStart(node, offset - seen)
      r.collapse(true)
      const sel = getSelection()
      sel?.removeAllRanges()
      sel?.addRange(r)
      return
    }
    seen += len
  }
  caretToEnd(host)
}

function selectAll(host: HTMLElement): void {
  const r = document.createRange()
  r.selectNodeContents(host)
  const sel = getSelection()
  sel?.removeAllRanges()
  sel?.addRange(r)
}

/** Split a block's html at the caret, returning [before, after]. */
function splitAtCaret(host: HTMLElement): [string, string] {
  const sel = getSelection()
  if (!sel || !sel.rangeCount) return [host.innerHTML, '']
  const r = sel.getRangeAt(0)
  const after = r.cloneRange()
  after.selectNodeContents(host)
  after.setStart(r.endContainer, r.endOffset)
  const tail = after.cloneContents()
  const before = r.cloneRange()
  before.selectNodeContents(host)
  before.setEnd(r.startContainer, r.startOffset)
  const head = before.cloneContents()
  const wrap = (f: DocumentFragment) => { const d = document.createElement('div'); d.append(f); return d.innerHTML }
  return [sanitizeInline(wrap(head)), sanitizeInline(wrap(tail))]
}

/** Where the caret is, in viewport coordinates. */
function caretRect(): DOMRect {
  const sel = getSelection()
  if (sel && sel.rangeCount) {
    const r = sel.getRangeAt(0).getBoundingClientRect()
    if (r.width || r.height || r.top) return r
  }
  return new DOMRect(80, 120, 0, 0)
}

/** Place a popover near an anchor without letting it leave the viewport. */
function place(pop: HTMLElement, anchor: HTMLElement | DOMRect): void {
  const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor
  const w = pop.offsetWidth || 260
  const h = pop.offsetHeight || 260
  let left = r.left
  let top = r.bottom + 6
  if (left + w > innerWidth - 8) left = Math.max(8, innerWidth - w - 8)
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6)
  pop.style.left = `${Math.max(8, left)}px`
  pop.style.top = `${top}px`
}

/**
 * A page's icon.
 *
 * `icon` is a NAME from the stylised set. Older documents (and anything an
 * agent writes) may carry an emoji instead, so that still renders — but the
 * set is what the app offers, because a sidebar of twelve colour emoji reads
 * as a row of stickers rather than one interface.
 */
export function pageIcon(icon: string | undefined): string {
  if (!icon) return ICONS.page
  if (icon in ICONS) return ICONS[icon as IconName]
  return escapeHtml(icon)   // an emoji, or anything else the file carried
}

/** The icons a page may choose from. */
export const PAGE_ICONS: IconName[] = [
  'page', 'note', 'book', 'folder', 'inbox', 'star', 'tag', 'hash',
  'compass', 'pen', 'scale', 'link', 'todo', 'code', 'image', 'archive',
]

/**
 * Replace text without touching markup.
 *
 * A naive string replace over `html` would happily rewrite a tag name or an
 * href — searching for "a" and replacing it would destroy every link on the
 * page. This walks the string and only substitutes OUTSIDE angle brackets.
 */

/**
 * Run after the next paint — but run REGARDLESS.
 *
 * `requestAnimationFrame` does not fire at all in a hidden tab, so anything
 * whose CORRECTNESS depends on it silently never happens: search a space,
 * switch tabs before the frame lands, come back, and the jump was never
 * completed. rAF is right when the page is visible (it is the only way to act
 * after layout); a timeout is the fallback that always arrives.
 */
export function afterPaint(fn: () => void): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { setTimeout(fn, 0); return }
  let done = false
  const once = () => { if (!done) { done = true; fn() } }
  requestAnimationFrame(once)
  setTimeout(once, 120)   // rAF starved (throttled tab, background window)
}
