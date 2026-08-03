// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
import type { BentoDoc, Slide, SlideElement } from './model'

export type StoreEvent =
  | 'doc'        // any document mutation
  | 'slides'     // slide list changed (add/remove/reorder) — sidebar rebuild
  | 'current'    // current slide switched
  | 'selection'  // selected element ids changed
  | 'dirty'      // dirty flag changed

type Listener = () => void

const MAX_UNDO = 100

/** Central state: document, current slide, selection, undo/redo, dirty flag. */
export class Store {
  doc: BentoDoc
  currentIndex = 0
  selection: string[] = []
  dirty = false
  /** editor-only: which showOnHover set the canvas previews (never saved) */
  hoverPreview: string | null = null

  private undoStack: BentoDoc[] = []
  private redoStack: BentoDoc[] = []
  private listeners = new Map<StoreEvent, Set<Listener>>()

  /** read-only viewer: block user edits (commit) while remote ops — which
   *  apply via the session's direct state.apply + emit, NOT commit — still
   *  flow, so a live viewer sees updates but can never author them. */
  readOnly = false

  constructor(doc: BentoDoc) {
    this.doc = doc
  }

  on(event: StoreEvent, fn: Listener): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(fn)
    return () => this.listeners.get(event)!.delete(fn)
  }

  emit(event: StoreEvent) {
    this.listeners.get(event)?.forEach((fn) => fn())
  }

  get slide(): Slide {
    // Empty decks are valid (AI often clears a deck before rebuilding it).
    // A runtime-only sentinel keeps legacy editor code inert until a real page
    // is inserted; it is never placed in doc.slides and therefore never saved.
    return this.doc.slides[this.currentIndex] ?? EMPTY_SLIDE
  }

  private _elCacheSlide = -1
  private _elMap = new Map<string, SlideElement>()

  /** Build the per-slide element lookup — O(n) once, then O(1) per lookup. */
  private ensureElMap(): Map<string, SlideElement> {
    if (this._elCacheSlide !== this.currentIndex) {
      this._elCacheSlide = this.currentIndex
      this._elMap.clear()
      for (const e of this.slide.elements) this._elMap.set(e.id, e)
    }
    return this._elMap
  }

  element(id: string): SlideElement | undefined {
    return this.ensureElMap().get(id)
  }

  get selectedElements(): SlideElement[] {
    const map = this.ensureElMap()
    const out: SlideElement[] = []
    for (const id of this.selection) {
      const e = map.get(id)
      if (e) out.push(e)
    }
    return out
  }

  /**
   * Replace the whole document (AI/JSON round-trip import). Undoable —
   * ⌘Z restores the previous document wholesale.
   */
  replaceDoc(next: BentoDoc) {
    this.checkpoint()
    this.doc = next
    this.currentIndex = 0
    this.selection = []
    this.setDirty(true)
    this.emit('slides')
    this.emit('current')
    this.emit('selection')
    this.emit('doc')
  }

  // --- history ------------------------------------------------------------

  /** Snapshot current doc state onto the undo stack. Call BEFORE a mutation. */
  checkpoint() {
    this.undoStack.push(structuredClone(this.doc))
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift()
    this.redoStack.length = 0
  }

  /** checkpoint() + mutate + notify, in one call. */
  commit(mutate: () => void, event: StoreEvent = 'doc') {
    if (this.readOnly) return // live viewer — user edits are inert
    this.checkpoint()
    mutate()
    this.touch(event)
  }

  /** Mark dirty and notify after an in-place mutation (no checkpoint). */
  touch(event: StoreEvent = 'doc') {
    this._elCacheSlide = -1 // element list may have changed
    this.doc.modified = new Date().toISOString()
    this.setDirty(true)
    this.emit('doc')
    if (event !== 'doc') this.emit(event)
  }

  undo() { this.restore(this.undoStack, this.redoStack) }
  redo() { this.restore(this.redoStack, this.undoStack) }

  private restore(from: BentoDoc[], to: BentoDoc[]) {
    const snapshot = from.pop()
    if (!snapshot) return
    to.push(structuredClone(this.doc))
    this.doc = snapshot
    this.currentIndex = Math.min(this.currentIndex, this.doc.slides.length - 1)
    this.selection = this.selection.filter((id) => this.element(id))
    this.setDirty(true)
    this.emit('doc')
    this.emit('slides')
    this.emit('current')
    this.emit('selection')
  }

  setDirty(dirty: boolean) {
    if (this.dirty === dirty) return
    this.dirty = dirty
    this.emit('dirty')
  }

  // --- navigation & selection ----------------------------------------------

  goTo(index: number) {
    const clamped = Math.max(0, Math.min(index, this.doc.slides.length - 1))
    if (clamped === this.currentIndex) return
    this.currentIndex = clamped
    this.selection = []
    this.hoverPreview = null
    this.emit('current')
    this.emit('selection')
  }

  /** Step forward/back one slide, skipping interactive states (stateOf) the way
   *  linear presentation does. dir = +1 next, -1 prev. */
  goToLinear(dir: 1 | -1) {
    const slides = this.doc.slides
    for (let i = this.currentIndex + dir; i >= 0 && i < slides.length; i += dir) {
      if (!slides[i].stateOf) { this.goTo(i); return }
    }
  }

  select(ids: string[]) {
    this.selection = ids
    this.emit('selection')
  }
}

const EMPTY_SLIDE: Slide = Object.freeze({
  id: '__bento-empty__', background: '#FFFFFF', transition: 'none', notes: '', elements: [],
}) as Slide
