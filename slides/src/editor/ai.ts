// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The WebDeck authors
// Browser-local AI copilot. The deck remains ordinary webdeck JSON: the
// model edits it through small, explicit tools and every mutation is undoable.

import type { Store } from '../store'
import { uid, type Slide, type SlideElement } from '../model'
import { t } from '../i18n'

type Role = 'user' | 'assistant'
type ToolEntry = { name: string; summary: string; ok: boolean }
type Activity = { type: 'reasoning'; content: string } | { type: 'tools'; items: ToolEntry[] }
type ChatEntry = { id: string; role: Role; content: string; activity: Activity[]; at: number }
type Config = { baseUrl: string; apiKey: string; model: string }
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }

const CONFIG_KEY = 'bento-ai-config'
const CHAT_PREFIX = 'bento-ai-chat-v2:'
const DEFAULT_CONFIG: Config = { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4.1' }

const SYSTEM_PROMPT = `# Role & objective
You are the slide-design copilot inside webdeck. Modify the live deck through tools; never dump document JSON into chat.

# Skills
Detailed instructions and valid examples are progressive. Before changing the deck, call load_skill for every relevant skill:
- deck-creation — required before creating pages or elements
- layout-design — required before positioning or restyling elements
- motion-design — required before adding transitions or animation
Do not guess the document schema from memory.

# Workflow
1. Inspect with get_document.
2. Load the relevant skill(s).
3. Create presentations ONE PAGE AT A TIME: exactly one create_slide call, wait for its result, then create the next page.
4. If a tool returns ok:false, correct the arguments using its error and retry. Never repeat identical invalid arguments.
5. An empty deck is valid. After finishing, answer in concise Markdown and only claim successful changes.`

const SKILLS: Record<string, string> = {
  'deck-creation': `# deck-creation
Create one complete page per create_slide call. Use the document size returned by get_document (normally 1280x720). IDs are stable strings and element IDs must be unique within a page.

## Required page shape
{ "id":"slide-unique", "name":"Readable name", "background":"#FFFFFF", "transition":"fade", "notes":"", "elements":[] }
transition is one of: none, fade, slide, zoom, morph, particle.

## Valid text element
{ "id":"title", "type":"text", "x":80, "y":70, "w":1120, "h":90, "rotation":0, "opacity":1, "html":"A concise title", "fontSize":54, "fontFamily":"Arial, sans-serif", "fontWeight":700, "color":"#1E2A3A", "align":"left", "valign":"middle", "lineHeight":1.1 }

## Valid shape element
{ "id":"panel", "type":"shape", "x":80, "y":190, "w":520, "h":390, "rotation":0, "opacity":1, "shape":"rect", "fill":"#F3F5F8", "stroke":"#D9E0E8", "strokeWidth":1, "radius":24 }
Allowed shape values are exactly: rect, ellipse, triangle, arrow, line, path. Use ellipse for circles; circle is invalid.

Prefer add_element when adding to an existing page. Keep rich text html limited to safe inline markup such as <b>, <i>, <u>, <br>, and <span>. Never put two pages in one create_slide call.`,
  'layout-design': `# layout-design
Read the target page first. Work in page coordinates. For 1280x720 use an outer margin of 64–96px, align edges to a small grid, keep at least 24px between unrelated objects, and preserve a clear title/content hierarchy. Keep x>=0, y>=0, x+w<=page width, y+h<=page height.

Use update_element with small patches:
{ "slide_id":"slide-1", "element_id":"title", "patch":{"x":80,"y":64,"w":1120,"h":88,"fontSize":52} }

Do not change id or type in a patch. Inspect again after a group of refinements. Avoid decorative clutter and verify contrast against the page background.`,
  'motion-design': `# motion-design
For a normal entrance, patch an element with fx, for example:
{ "slide_id":"slide-2", "element_id":"metric", "patch":{"fx":{"enter":"fade-up","enterDur":0.55,"order":2,"countUp":true}} }

For silky cross-page movement, the incoming page must use transition:"morph". Matching elements on adjacent pages must share the same id, or share the same morphId. Reuse IDs only across different pages, never twice on one page. Keep conceptual identity honest: pair the same title/card/chart, not unrelated objects. Morph supplies movement; do not also add entrance animation to the same matched element.`
}

const tools = [
  tool('load_skill', 'Load authoritative instructions and valid examples for one slide-design skill. Required before editing.', {
    type: 'object', properties: { name: { type: 'string', enum: Object.keys(SKILLS) } }, required: ['name'], additionalProperties: false,
  }, true),
  tool('get_document', 'Read the current webdeck document or one page before editing.', {
    type: 'object', properties: { slide_id: { type: ['string', 'null'], description: 'Page id, or null for the whole document.' } }, required: ['slide_id'], additionalProperties: false,
  }, true),
  tool('create_slide', 'Create exactly ONE page. Call repeatedly, once per page. The page is appended unless after_slide_id is supplied.', {
    type: 'object', properties: {
      slide: { type: 'object', description: 'One complete Slide object with background, transition, notes, and elements.' },
      after_slide_id: { type: 'string', description: 'Optional existing page id after which to insert.' },
    }, required: ['slide'], additionalProperties: false,
  }),
  tool('update_slide', 'Patch page-level properties such as name, background, transition, notes, hover, or stateOf.', {
    type: 'object', properties: { slide_id: { type: 'string' }, patch: { type: 'object' } }, required: ['slide_id', 'patch'], additionalProperties: false,
  }),
  tool('update_element', 'Precisely patch one element, including its layout, styling, content, morph id, or animation.', {
    type: 'object', properties: { slide_id: { type: 'string' }, element_id: { type: 'string' }, patch: { type: 'object' } }, required: ['slide_id', 'element_id', 'patch'], additionalProperties: false,
  }),
  tool('add_element', 'Add one complete element to an existing page. Load deck-creation first.', {
    type: 'object', properties: { slide_id: { type: 'string' }, element: { type: 'object' } }, required: ['slide_id', 'element'], additionalProperties: false,
  }),
  tool('delete_slide', 'Delete one page. It is valid to delete the last page.', {
    type: 'object', properties: { slide_id: { type: 'string' } }, required: ['slide_id'], additionalProperties: false,
  }, true),
  tool('delete_element', 'Delete one element from a page.', {
    type: 'object', properties: { slide_id: { type: 'string' }, element_id: { type: 'string' } }, required: ['slide_id', 'element_id'], additionalProperties: false,
  }, true),
]

function tool(name: string, description: string, parameters: Record<string, unknown>, strict = false) {
  return { type: 'function', function: { name, description, parameters, strict } }
}

export class AiPanel {
  private entries: ChatEntry[] = []
  private docId = ''
  private messages!: HTMLElement
  private input!: HTMLTextAreaElement
  private send!: HTMLButtonElement
  private stop!: HTMLButtonElement
  private abort: AbortController | null = null
  /** Streaming rebuilds the message DOM for every delta. Remember which
   * disclosure widgets the user opened so they do not snap shut mid-read. */
  private openDetails = new Set<string>()

  constructor(private host: HTMLElement, private store: Store, private onClose: () => void) {
    this.docId = store.doc.docId
    this.entries = loadJson<ChatEntry[]>(this.chatKey(), [])
    this.build()
    store.on('doc', () => {
      if (store.doc.docId === this.docId) return
      this.docId = store.doc.docId
      this.entries = loadJson<ChatEntry[]>(this.chatKey(), [])
      this.render()
    })
  }

  focus() { this.input.focus() }

  private chatKey() { return CHAT_PREFIX + this.docId }
  private save() { try { localStorage.setItem(this.chatKey(), JSON.stringify(this.entries.slice(-200))) } catch { /* storage unavailable */ } }

  private build() {
    this.host.className = 'ed-ai'
    const head = document.createElement('div')
    head.className = 'ed-ai-head'
    head.innerHTML = `<div><span class="ed-ai-spark">✦</span><b>${t('AI copilot')}</b><small>${t('Creates one page at a time')}</small></div>`
    const settings = button('⚙', t('AI settings'))
    const close = button('×', t('Close AI copilot'))
    settings.addEventListener('click', () => this.settings())
    close.addEventListener('click', this.onClose)
    head.append(settings, close)
    this.messages = document.createElement('div')
    this.messages.className = 'ed-ai-messages'
    // Native <details> toggles after click dispatch. During streaming, a delta
    // can rebuild the message DOM in that tiny gap and discard the toggle.
    // Own the interaction synchronously so every subsequent rebuild inherits
    // the user's intent immediately.
    const toggleDetails = (event: Event) => {
      const summary = (event.target as Element).closest('summary')
      const details = summary?.parentElement as HTMLDetailsElement | null
      const key = details?.dataset.detailKey
      if (!summary || !details || !key) return
      event.preventDefault()
      const open = !details.open
      details.open = open
      if (open) this.openDetails.add(key)
      else this.openDetails.delete(key)
    }
    // pointerdown happens before a streaming repaint can replace the node
    // between press and click. Keyboard activation stays explicit as well.
    this.messages.addEventListener('pointerdown', toggleDetails)
    // We already toggled on pointerdown. Suppress the later native click
    // default or a stable (non-streaming) <details> would immediately flip back.
    this.messages.addEventListener('click', (event) => {
      if ((event.target as Element).closest('summary')) event.preventDefault()
    })
    this.messages.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') toggleDetails(event)
    })
    const composer = document.createElement('div')
    composer.className = 'ed-ai-compose'
    this.input = document.createElement('textarea')
    this.input.rows = 3
    this.input.placeholder = t('Describe the presentation or the change you want…')
    this.send = iconButton(sendIcon(), t('Send'))
    this.send.classList.add('ed-ai-send')
    this.stop = iconButton(stopIcon(), t('Stop'))
    this.stop.classList.add('ed-ai-stop')
    this.stop.hidden = true
    this.send.addEventListener('click', () => void this.submit())
    this.stop.addEventListener('click', () => this.abort?.abort())
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.submit() }
    })
    composer.append(this.input, this.send, this.stop)
    this.host.replaceChildren(head, this.messages, composer)
    this.render()
  }

  private render() {
    const followOutput = this.openDetails.size === 0 &&
      this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight < 48
    for (const detail of this.messages.querySelectorAll<HTMLDetailsElement>('details[data-detail-key]')) {
      const key = detail.dataset.detailKey!
      if (detail.open) this.openDetails.add(key)
      else this.openDetails.delete(key)
    }
    this.messages.innerHTML = ''
    if (!this.entries.length) {
      const empty = document.createElement('div')
      empty.className = 'ed-ai-empty'
      empty.innerHTML = `<span>✦</span><b>${t('Build with AI')}</b><p>${t('Ask for a deck, then watch each page appear. You can keep chatting to refine layout, copy, and animation.')}</p>`
      this.messages.appendChild(empty)
    }
    for (const entry of this.entries) this.messages.appendChild(this.entryNode(entry))
    // Follow new output only while the user is already at the bottom and is
    // not reading an expanded trace. An open reasoning block grows on every
    // token; forcing scrollTop to the new bottom made the panel run away from
    // the heading and rendered its navigation unusable.
    if (followOutput) this.messages.scrollTop = this.messages.scrollHeight
  }

  private entryNode(entry: ChatEntry) {
    const wrap = document.createElement('article')
    wrap.className = `ed-ai-message ${entry.role}`
    let reasoningNumber = 0
    entry.activity.forEach((activity, index) => {
      const details = document.createElement('details')
      const detailKey = `${entry.id}:activity:${index}`
      details.dataset.detailKey = detailKey
      details.open = this.openDetails.has(detailKey)
      const summary = document.createElement('summary')
      if (activity.type === 'reasoning') {
        reasoningNumber++
        details.className = 'ed-ai-reasoning'
        summary.textContent = `${t('Thinking')} ${reasoningNumber}`
        const body = document.createElement('div')
        body.textContent = activity.content
        details.append(summary, body)
      } else {
        details.className = 'ed-ai-tools'
        summary.textContent = t('{n} tool calls', { n: activity.items.length })
        const list = document.createElement('ol')
        for (const call of activity.items) {
          const li = document.createElement('li')
          li.innerHTML = `<span>${call.ok ? '✓' : '!'}</span><b>${escapeHtml(call.name)}</b><small>${escapeHtml(call.summary)}</small>`
          list.appendChild(li)
        }
        details.append(summary, list)
      }
      wrap.appendChild(details)
    })
    if (entry.content || entry.role === 'assistant') {
      const body = document.createElement('div')
      body.className = 'ed-ai-md'
      body.innerHTML = markdown(entry.content || (this.abort ? '▍' : ''))
      wrap.appendChild(body)
    }
    return wrap
  }

  private async submit() {
    const text = this.input.value.trim()
    if (!text || this.abort) return
    const cfg = loadJson<Config>(CONFIG_KEY, DEFAULT_CONFIG)
    if (!cfg.apiKey || !cfg.model || !cfg.baseUrl) { this.settings(); return }
    this.input.value = ''
    this.entries.push({ id: uid('chat'), role: 'user', content: text, activity: [], at: Date.now() })
    const live: ChatEntry = { id: uid('chat'), role: 'assistant', content: '', activity: [], at: Date.now() }
    this.entries.push(live)
    this.abort = new AbortController()
    this.send.hidden = true; this.stop.hidden = false; this.input.disabled = true
    this.render()
    try {
      await this.run(cfg, live)
    } catch (error) {
      if ((error as Error).name !== 'AbortError') live.content += `\n\n> ${t('Error')}: ${(error as Error).message}`
    } finally {
      this.abort = null
      this.send.hidden = false; this.stop.hidden = true; this.input.disabled = false
      this.save(); this.render(); this.input.focus()
    }
  }

  private async run(cfg: Config, live: ChatEntry) {
    const history: any[] = [{ role: 'system', content: SYSTEM_PROMPT }]
    for (const e of this.entries.slice(0, -1)) history.push({ role: e.role, content: e.content })
    // Deliberately unbounded: stop only when the model stops requesting tools,
    // the user aborts, or the provider returns an error.
    while (true) {
      const contentAt = live.content.length
      const reasoning: Activity = { type: 'reasoning', content: '' }
      live.activity.push(reasoning)
      const calls = await this.streamCompletion(cfg, history, live, reasoning)
      if (!reasoning.content) live.activity.pop()
      if (!calls.length) break
      const assistant: any = { role: 'assistant', content: live.content.slice(contentAt) || null, tool_calls: calls }
      if (reasoning.content) assistant.reasoning_content = reasoning.content
      history.push(assistant)
      let toolGroup = live.activity.at(-1)
      if (toolGroup?.type !== 'tools') {
        toolGroup = { type: 'tools', items: [] }
        live.activity.push(toolGroup)
      }
      for (const call of calls) {
        const result = this.execute(call)
        toolGroup.items.push({ name: call.function.name, summary: result.summary, ok: result.ok })
        history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
        this.save(); this.render()
      }
      live.content = ''
    }
  }

  private async streamCompletion(cfg: Config, history: any[], live: ChatEntry, reasoning: Extract<Activity, { type: 'reasoning' }>): Promise<ToolCall[]> {
    const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions'
    const response = await fetch(url, {
      method: 'POST', signal: this.abort!.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model, messages: history, tools, tool_choice: 'auto', stream: true,
        // Page creation must be observable and ordered: one call completes
        // before the model receives permission to create the next page.
        parallel_tool_calls: false,
      }),
    })
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    if (!response.body) throw new Error(t('This API did not return a stream.'))
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let buffer = ''
    const calls = new Map<number, ToolCall>()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        let chunk: any
        try { chunk = JSON.parse(data) } catch { continue }
        const delta = chunk.choices?.[0]?.delta ?? chunk.delta ?? {}
        if (typeof delta.content === 'string') live.content += delta.content
        const reasoningDelta = delta.reasoning_content ?? delta.reasoning ?? delta.thinking
        if (typeof reasoningDelta === 'string') reasoning.content += reasoningDelta
        for (const part of delta.tool_calls ?? []) {
          const index = part.index ?? 0
          const call = calls.get(index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } }
          if (part.id) call.id = part.id
          if (part.function?.name) call.function.name += part.function.name
          if (part.function?.arguments) call.function.arguments += part.function.arguments
          calls.set(index, call)
        }
        this.render()
      }
    }
    return [...calls.values()]
  }

  private execute(call: ToolCall): { ok: boolean; summary: string; data?: unknown } {
    try {
      const a = JSON.parse(call.function.arguments || '{}')
      if (call.function.name === 'load_skill') {
        const content = SKILLS[a.name]
        return content
          ? { ok: true, summary: `Loaded ${a.name}`, data: content }
          : { ok: false, summary: `Unknown skill: ${String(a.name)}. Choose one of: ${Object.keys(SKILLS).join(', ')}` }
      }
      if (call.function.name === 'get_document') {
        const slide = a.slide_id ? this.store.doc.slides.find((s) => s.id === a.slide_id) : undefined
        return { ok: true, summary: slide ? `Read ${slide.id}` : `Read ${this.store.doc.slides.length} pages`, data: slide ?? this.store.doc }
      }
      if (call.function.name === 'create_slide') {
        const normalized = normalizeSlide(a.slide)
        if (!normalized.ok) return normalized
        const slide = normalized.data!
        if (this.store.doc.slides.some((s) => s.id === slide.id)) return { ok: false, summary: `Duplicate page id: ${slide.id}` }
        let at = this.store.doc.slides.length
        if (a.after_slide_id) { const i = this.store.doc.slides.findIndex((s) => s.id === a.after_slide_id); if (i >= 0) at = i + 1 }
        try {
          this.store.commit(() => this.store.doc.slides.splice(at, 0, slide), 'slides')
          this.store.goTo(at)
        } catch (error) {
          // Store listeners render synchronously. A renderer exception must not
          // leave behind a page that the model believes failed to create.
          const inserted = this.store.doc.slides.indexOf(slide)
          if (inserted >= 0) this.store.doc.slides.splice(inserted, 1)
          this.store.currentIndex = Math.max(0, Math.min(this.store.currentIndex, this.store.doc.slides.length - 1))
          try { this.store.emit('slides'); this.store.emit('current'); this.store.emit('doc') } catch { /* original error is more useful */ }
          return { ok: false, summary: `Page was rejected and rolled back: ${(error as Error).message}` }
        }
        return { ok: true, summary: `Created page ${at + 1} (${slide.id})` }
      }
      const si = this.store.doc.slides.findIndex((s) => s.id === a.slide_id)
      if (si < 0) return { ok: false, summary: `Page not found: ${a.slide_id}` }
      if (call.function.name === 'add_element') {
        const checked = validateElement(a.element)
        if (!checked.ok) return checked
        if (this.store.doc.slides[si].elements.some((e) => e.id === a.element.id)) {
          return { ok: false, summary: `Duplicate element id on this page: ${a.element.id}. Choose a unique id.` }
        }
        this.store.commit(() => this.store.doc.slides[si].elements.push(structuredClone(a.element)))
        return { ok: true, summary: `Added ${a.element.id} to ${a.slide_id}` }
      }
      if (call.function.name === 'delete_slide') {
        this.store.commit(() => this.store.doc.slides.splice(si, 1), 'slides')
        this.store.currentIndex = Math.max(0, Math.min(si, this.store.doc.slides.length - 1))
        this.store.select([]); this.store.emit('current')
        return { ok: true, summary: `Deleted ${a.slide_id}` }
      }
      if (call.function.name === 'update_slide') {
        const forbidden = new Set(['id', 'elements'])
        this.store.commit(() => Object.entries(a.patch ?? {}).forEach(([k, v]) => { if (!forbidden.has(k)) (this.store.doc.slides[si] as any)[k] = v }))
        return { ok: true, summary: `Updated ${a.slide_id}` }
      }
      const ei = this.store.doc.slides[si].elements.findIndex((e) => e.id === a.element_id)
      if (ei < 0) return { ok: false, summary: `Element not found: ${a.element_id}` }
      if (call.function.name === 'delete_element') {
        this.store.commit(() => this.store.doc.slides[si].elements.splice(ei, 1))
        return { ok: true, summary: `Deleted ${a.element_id}` }
      }
      if (call.function.name === 'update_element') {
        const forbidden = new Set(['id', 'type'])
        const next = structuredClone(this.store.doc.slides[si].elements[ei]) as any
        Object.entries(a.patch ?? {}).forEach(([k, v]) => { if (!forbidden.has(k)) next[k] = v })
        const checked = validateElement(next)
        if (!checked.ok) return { ok: false, summary: `Invalid element patch: ${checked.summary}` }
        this.store.commit(() => { this.store.doc.slides[si].elements[ei] = next })
        return { ok: true, summary: `Refined ${a.element_id}` }
      }
      return { ok: false, summary: `Unknown tool: ${call.function.name}` }
    } catch (error) { return { ok: false, summary: (error as Error).message } }
  }

  private settings() {
    const cfg = loadJson<Config>(CONFIG_KEY, DEFAULT_CONFIG)
    const shade = document.createElement('div')
    shade.className = 'ed-ai-modal'
    shade.innerHTML = `<form><h2>${t('AI settings')}</h2><label>${t('API base URL')}<input name="url" type="url" required></label><label>${t('API key')}<input name="key" type="password" autocomplete="off"></label><label>${t('Model name')}<input name="model" required></label><p>${t('Settings stay in this browser and are never saved into the presentation file.')}</p><div><button type="button">${t('Cancel')}</button><button class="ed-btn-primary" type="submit">${t('Save')}</button></div></form>`
    const form = shade.querySelector('form')!
    ;(form.elements.namedItem('url') as HTMLInputElement).value = cfg.baseUrl
    ;(form.elements.namedItem('key') as HTMLInputElement).value = cfg.apiKey
    ;(form.elements.namedItem('model') as HTMLInputElement).value = cfg.model
    form.querySelector<HTMLButtonElement>('button[type=button]')!.onclick = () => shade.remove()
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const next = { baseUrl: (form.elements.namedItem('url') as HTMLInputElement).value.trim(), apiKey: (form.elements.namedItem('key') as HTMLInputElement).value.trim(), model: (form.elements.namedItem('model') as HTMLInputElement).value.trim() }
      localStorage.setItem(CONFIG_KEY, JSON.stringify(next)); shade.remove(); this.input.focus()
    })
    shade.addEventListener('mousedown', (e) => { if (e.target === shade) shade.remove() })
    document.body.appendChild(shade)
  }
}

type ToolResult<T = unknown> = { ok: boolean; summary: string; data?: T }

function normalizeSlide(value: unknown): ToolResult<Slide> {
  if (!value || typeof value !== 'object') return { ok: false, summary: 'slide must be an object. Load deck-creation for a valid example.' }
  const s = structuredClone(value) as Partial<Slide>
  if (!Array.isArray(s.elements)) return { ok: false, summary: 'slide.elements must be an array. Load deck-creation and retry.' }
  s.id = typeof s.id === 'string' && s.id ? s.id : uid('slide')
  s.background = typeof s.background === 'string' ? s.background : '#FFFFFF'
  s.transition = ['none', 'fade', 'slide', 'zoom', 'morph', 'particle'].includes(String(s.transition)) ? s.transition : 'fade'
  s.notes = typeof s.notes === 'string' ? s.notes : ''
  const ids = new Set<string>()
  for (const e of s.elements as SlideElement[]) {
    const checked = validateElement(e)
    if (!checked.ok) return { ok: false, summary: `Invalid element in page ${s.id}: ${checked.summary}` }
    if (ids.has(e.id)) return { ok: false, summary: `Duplicate element id in page ${s.id}: ${e.id}` }
    ids.add(e.id)
  }
  return { ok: true, summary: 'Valid slide', data: s as Slide }
}

function validateElement(value: unknown): ToolResult<SlideElement> {
  if (!value || typeof value !== 'object') return { ok: false, summary: 'element must be an object' }
  const e = value as Record<string, unknown>
  const missing = ['id', 'type', 'x', 'y', 'w', 'h', 'rotation', 'opacity'].filter((k) => e[k] === undefined)
  if (missing.length) return { ok: false, summary: `element is missing required fields: ${missing.join(', ')}. Load deck-creation for examples.` }
  if (typeof e.id !== 'string' || !e.id) return { ok: false, summary: 'element.id must be a non-empty string' }
  for (const k of ['x', 'y', 'w', 'h', 'rotation', 'opacity']) if (typeof e[k] !== 'number' || !Number.isFinite(e[k])) return { ok: false, summary: `element.${k} must be a finite number` }
  if ((e.w as number) <= 0 || (e.h as number) <= 0) return { ok: false, summary: 'element width and height must be greater than zero' }
  const required: Record<string, string[]> = {
    text: ['html', 'fontSize', 'fontFamily', 'fontWeight', 'color', 'align', 'valign', 'lineHeight'],
    shape: ['shape', 'fill', 'stroke', 'strokeWidth'], image: ['src', 'fit'],
    chart: ['option'], table: ['rows'], media: ['src', 'kind'], svg: ['svg'],
  }
  const typeFields = required[String(e.type)]
  if (!typeFields) return { ok: false, summary: `unsupported element type: ${String(e.type)}` }
  const typeMissing = typeFields.filter((k) => e[k] === undefined)
  if (typeMissing.length) return { ok: false, summary: `${String(e.type)} element is missing: ${typeMissing.join(', ')}. Load deck-creation for a valid example.` }
  if (e.type === 'shape' && !['rect', 'ellipse', 'triangle', 'arrow', 'line', 'path'].includes(String(e.shape))) {
    return { ok: false, summary: `unsupported shape: ${String(e.shape)}. Use rect, ellipse, triangle, arrow, line, or path; use ellipse for a circle.` }
  }
  if (e.type === 'text' && !['left', 'center', 'right'].includes(String(e.align))) return { ok: false, summary: `unsupported text align: ${String(e.align)}` }
  if (e.type === 'text' && !['top', 'middle', 'bottom'].includes(String(e.valign))) return { ok: false, summary: `unsupported text valign: ${String(e.valign)}` }
  return { ok: true, summary: 'Valid element', data: value as SlideElement }
}

function loadJson<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) ?? '') as T } catch { return fallback } }
function button(text: string, title: string) { const b = document.createElement('button'); b.type = 'button'; b.className = 'ed-btn'; b.textContent = text; b.title = title; return b }
function iconButton(svg: string, title: string) { const b = document.createElement('button'); b.type = 'button'; b.className = 'ed-btn'; b.innerHTML = svg; b.title = title; b.setAttribute('aria-label', title); return b }
function sendIcon() { return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 19V5m0 0-6 6m6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/></svg>' }
function stopIcon() { return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/></svg>' }
function escapeHtml(s: string) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!) }
function markdown(source: string) {
  let s = renderMarkdownTables(escapeHtml(source))
  s = s.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>').replace(/^- (.+)$/gm, '<li>$1</li>')
  return s.split(/\n{2,}/).map((p) => /^(<h|<pre|<blockquote|<li|<div class="ed-ai-table-wrap")/.test(p) ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')
}

/** Convert GFM-style tables before the inline Markdown pass. Input is already
 * escaped, so generated cells cannot inject markup. Leading/trailing pipes
 * are optional; the delimiter row is what distinguishes a table from prose. */
function renderMarkdownTables(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((v) => v.trim())
  const delimiter = (line: string) => cells(line).every((v) => /^:?-{3,}:?$/.test(v))
  for (let i = 0; i < lines.length; i++) {
    if (i + 1 >= lines.length || !lines[i].includes('|') || !delimiter(lines[i + 1])) { out.push(lines[i]); continue }
    const head = cells(lines[i])
    const rows: string[][] = []
    i += 2
    while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(cells(lines[i])); i++ }
    i--
    out.push(`<div class="ed-ai-table-wrap"><table><thead><tr>${head.map((v) => `<th>${v}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${head.map((_, c) => `<td>${row[c] ?? ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`, '')
  }
  return out.join('\n')
}
