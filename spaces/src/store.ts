// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Document state, undo history, and the TYPING RUN.
//
// Slides sidesteps commit granularity because canvas text commits on blur. A
// notes app may never blur, so this one policy sets undo granularity, autosave
// churn, the dirty flag, and later the collaboration op rate.
//
// A TYPING RUN is consecutive input in ONE block with no structural op between.
// It takes ONE checkpoint, at its first input; later inputs mutate in place. It
// closes on idle, on the caret leaving the block, on any structural change, on
// save, and on replaceDoc. One run = one undo entry = later, one text batch.

import { type SpacesDoc, type Page, type Block, buildIndex, type SpaceIndex, homePage } from './model'

type Listener = () => void
type Event = 'doc' | 'page' | 'tree' | 'selection'

/** Idle that closes a run. Autosave debounces longer, so no snapshot lands mid-run. */
const RUN_IDLE_MS = 600
/** Undo is bounded by BYTES, not entries: at 200 pages, 100 whole-document
 *  snapshots retain tens of MB. Assets are excluded from snapshots entirely. */
const UNDO_BUDGET = 24 * 1024 * 1024

interface Entry {
  json: string
  /** page in view when the entry was taken, so undo restores the view too */
  pageId: string
}

export class Store {
  doc: SpacesDoc
  index: SpaceIndex
  /** the page being viewed */
  pageId: string
  /** blocks currently selected at block level (Esc from text editing) */
  selection: string[] = []
  readOnly = false

  private undoStack: Entry[] = []
  private redoStack: Entry[] = []
  private listeners = new Map<Event, Set<Listener>>()
  private runBlock: string | null = null
  private runTimer: ReturnType<typeof setTimeout> | undefined

  constructor(doc: SpacesDoc) {
    this.doc = doc
    this.index = buildIndex(doc)
    this.pageId = homePage(doc)?.id ?? ''
  }

  // ---- events -------------------------------------------------------------
  on(ev: Event, fn: Listener): () => void {
    const set = this.listeners.get(ev) ?? new Set()
    set.add(fn)
    this.listeners.set(ev, set)
    return () => set.delete(fn)
  }

  emit(ev: Event): void {
    for (const fn of this.listeners.get(ev) ?? []) fn()
  }

  // ---- reads --------------------------------------------------------------
  get page(): Page | undefined {
    return this.index.page.get(this.pageId)
  }

  block(id: string): Block | undefined {
    return this.index.block.get(id)?.block
  }

  /** Pages in sidebar order: a depth-first walk of the page tree. */
  tree(parent = '', depth = 0): Array<{ page: Page; depth: number }> {
    const out: Array<{ page: Page; depth: number }> = []
    for (const p of this.index.children.get(parent) ?? []) {
      out.push({ page: p, depth })
      out.push(...this.tree(p.id, depth + 1))
    }
    return out
  }

  // ---- writes -------------------------------------------------------------
  /**
   * A structural change: one undoable step. Closes any open typing run first,
   * so the run's text and the structural edit never merge into one entry.
   */
  commit(mutate: () => void, opts: { structure?: boolean } = {}): void {
    if (this.readOnly) return
    this.endRun()
    this.checkpoint()
    mutate()
    this.reindex()
    this.emit('doc')
    if (opts.structure !== false) this.emit('tree')
  }

  /**
   * An input inside a typing run. The FIRST input in a block checkpoints;
   * every later one mutates in place.
   */
  runEdit(blockId: string, mutate: () => void): void {
    if (this.readOnly) return
    if (this.runBlock !== blockId) {
      this.endRun()
      this.checkpoint()
      this.runBlock = blockId
    }
    mutate()
    this.touch()
    clearTimeout(this.runTimer)
    this.runTimer = setTimeout(() => this.endRun(), RUN_IDLE_MS)
  }

  /** Close the current run, if any. Idempotent. */
  endRun(): void {
    clearTimeout(this.runTimer)
    if (!this.runBlock) return
    const id = this.runBlock
    this.runBlock = null
    this.emit('doc')
    void id
  }

  /** Model changed without a new undo entry (mid-run). */
  touch(): void {
    this.doc.modified = new Date().toISOString()
    this.reindex()
  }

  private reindex(): void {
    this.index = buildIndex(this.doc)
    if (!this.index.page.has(this.pageId)) this.pageId = homePage(this.doc)?.id ?? ''
  }

  // ---- history ------------------------------------------------------------
  private snapshot(): string {
    // assets are excluded: they are the largest thing in the document and never
    // change during an ordinary edit, so snapshotting them 100 times is waste
    const { assets: _assets, ...rest } = this.doc
    return JSON.stringify(rest)
  }

  checkpoint(): void {
    if (this.readOnly) return
    this.undoStack.push({ json: this.snapshot(), pageId: this.pageId })
    this.redoStack.length = 0
    let bytes = 0
    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      bytes += this.undoStack[i].json.length
      if (bytes > UNDO_BUDGET) { this.undoStack.splice(0, i + 1); break }
    }
  }

  private restore(entry: Entry): void {
    const assets = this.doc.assets
    this.doc = { ...(JSON.parse(entry.json) as SpacesDoc), ...(assets ? { assets } : {}) }
    this.pageId = entry.pageId
    this.reindex()
    this.emit('doc')
    this.emit('tree')
    this.emit('page')
  }

  undo(): void {
    if (this.readOnly) return
    this.endRun()
    const entry = this.undoStack.pop()
    if (!entry) return
    this.redoStack.push({ json: this.snapshot(), pageId: this.pageId })
    this.restore(entry)
  }

  redo(): void {
    if (this.readOnly) return
    this.endRun()
    const entry = this.redoStack.pop()
    if (!entry) return
    this.undoStack.push({ json: this.snapshot(), pageId: this.pageId })
    this.restore(entry)
  }

  get canUndo(): boolean { return this.undoStack.length > 0 }
  get canRedo(): boolean { return this.redoStack.length > 0 }

  // ---- navigation ---------------------------------------------------------
  goToPage(id: string, opts: { push?: boolean } = {}): void {
    if (!this.index.page.has(id) || id === this.pageId) return
    this.pageId = id
    this.selection = []
    this.endRun()
    if (opts.push !== false && typeof history !== 'undefined') {
      // pushState with a FRAGMENT is legal from an opaque origin; pushState
      // with a PATH throws SecurityError there. Measured — this is why links
      // are fragments (docs/DECISIONS.md, 2026-08-03).
      try { history.pushState(null, '', `#p/${id}`) } catch { /* opaque origin edge */ }
    }
    this.emit('page')
    this.emit('tree')
  }

  select(ids: string[]): void {
    this.selection = ids
    this.emit('selection')
  }

  /** Replace the whole document — the AI round-trip and version restore path. */
  replaceDoc(next: SpacesDoc): void {
    this.endRun()
    this.checkpoint()
    this.doc = next
    this.reindex()
    this.pageId = homePage(next)?.id ?? ''
    this.emit('doc')
    this.emit('tree')
    this.emit('page')
  }
}
