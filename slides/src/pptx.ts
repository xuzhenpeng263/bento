// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The WebDeck authors
// Editable PowerPoint export. Screen-only behaviours (hover, particle/morph
// runtime, media playback) intentionally degrade; ordinary objects stay native.

import PptxGenJS from 'pptxgenjs'
import type { BentoDoc, ChartElement, ImageElement, MediaElement, ShapeElement, SlideElement, SvgElement, TableElement, TextElement } from './model'

const PPT_W = 13.333

export interface PptxEffectLosses {
  transitions: number
  entrances: number
  loops: number
  interactions: number
}

/** Effects that PowerPoint cannot receive through PptxGenJS. */
export function pptxEffectLosses(doc: BentoDoc): PptxEffectLosses {
  const losses: PptxEffectLosses = { transitions: 0, entrances: 0, loops: 0, interactions: 0 }
  for (const page of doc.slides) {
    if (page.transition !== 'none') losses.transitions++
    if (page.stateOf || page.hover) losses.interactions++
    for (const el of page.elements) {
      if (el.fx?.enter || el.fx?.countUp) losses.entrances++
      if (el.fx?.ambient || el.fx?.loop) losses.loops++
      if (el.showOnHover || (el.type === 'svg' && el.css?.trim())) losses.interactions++
    }
  }
  return losses
}

export async function exportPptx(doc: BentoDoc, fileName: string): Promise<void> {
  const pptx = new PptxGenJS()
  const pptH = PPT_W * doc.size.height / doc.size.width
  pptx.defineLayout({ name: 'BENTO', width: PPT_W, height: pptH })
  pptx.layout = 'BENTO'
  pptx.author = doc.meta?.author || 'webdeck'
  pptx.company = doc.meta?.company || 'webdeck'
  pptx.subject = doc.meta?.subject || ''
  pptx.title = doc.title
  pptx.theme = {
    headFontFace: fontFace(doc.theme.fontFamily),
    bodyFontFace: fontFace(doc.theme.fontFamily),
  }
  const sx = PPT_W / doc.size.width
  const sy = pptH / doc.size.height
  for (const page of doc.slides) {
    if (page.stateOf) continue
    const slide = pptx.addSlide()
    slide.background = { color: color(page.background || doc.theme.background) }
    if (page.notes) slide.addNotes(page.notes)
    for (const el of page.elements) await addElement(pptx, slide, el, doc, sx, sy)
  }
  await pptx.writeFile({ fileName })
}

async function addElement(pptx: PptxGenJS, slide: any, el: SlideElement, doc: BentoDoc, sx: number, sy: number) {
  const box = { x: el.x * sx, y: el.y * sy, w: el.w * sx, h: el.h * sy, rotate: el.rotation || 0 }
  if (el.type === 'text') return addText(slide, el, box)
  if (el.type === 'shape') return addShape(pptx, slide, el, box)
  if (el.type === 'image') return addImage(slide, el, doc, box)
  if (el.type === 'svg') return addSvg(slide, el, doc, box)
  if (el.type === 'table') return addTable(slide, el, box)
  if (el.type === 'chart') return addChart(pptx, slide, el, box)
  if (el.type === 'media') return addMedia(slide, el, doc, box)
}

async function addMedia(slide: any, el: MediaElement, doc: BentoDoc, box: any) {
  const src = await resolveAsset(el.src, doc)
  const cover = el.poster ? await resolveAsset(el.poster, doc) : null
  if (!src) {
    if (cover) slide.addImage({ data: cover, ...box, transparency: opacity(el.opacity) })
    return
  }
  const mime = src.match(/^data:([^;,]+)/i)?.[1]
  const extn = mime?.split('/')[1]?.replace('mpeg', 'mp3').replace('quicktime', 'mov') || (el.kind === 'audio' ? 'mp3' : 'mp4')
  slide.addMedia({ type: el.kind, data: src, extn, cover: cover || undefined, ...box })
}

function addText(slide: any, el: TextElement, box: any) {
  const text = htmlText(el.html)
  if (!text && el.placeholder) return
  slide.addText(text, {
    ...box, margin: 0, breakLine: false, fit: 'shrink',
    fontFace: fontFace(el.fontFamily), fontSize: Math.max(1, el.fontSize * .75),
    bold: el.fontWeight >= 600, color: color(el.color),
    align: el.align, valign: el.valign, paraSpaceAfterPt: 0,
    // PptxGenJS wants the literal multiplier (1.2 = 120%), not a percentage.
    // Passing 120 produces 120× spacing and pushes every line outside its box.
    lineSpacingMultiple: Math.max(.5, Math.min(4, el.lineHeight || 1.2)),
    charSpacing: el.letterSpacing ? el.letterSpacing * .75 : 0,
    transparency: opacity(el.opacity),
  })
}

function addShape(pptx: PptxGenJS, slide: any, el: ShapeElement, box: any) {
  const map: Record<string, any> = {
    rect: el.radius ? pptx.ShapeType.roundRect : pptx.ShapeType.rect,
    ellipse: pptx.ShapeType.ellipse, triangle: pptx.ShapeType.triangle,
    arrow: pptx.ShapeType.rightArrow, line: pptx.ShapeType.line,
  }
  const shape = map[el.shape]
  if (!shape || el.shape === 'path') return
  const fillColor = el.fillGradient?.stops[0]?.color || el.fill
  const opts: any = {
    ...box,
    fill: { color: color(fillColor), transparency: opacity(el.opacity) },
    line: {
      color: color(el.stroke || 'transparent'), width: Math.max(0, el.strokeWidth * .75),
      transparency: el.stroke === 'transparent' || !el.strokeWidth ? 100 : 0,
      dash: el.strokeStyle === 'dotted' ? 'dash' : el.strokeStyle === 'dashed' || el.strokeDash ? 'dash' : 'solid',
    },
  }
  if (el.shape === 'line') {
    opts.fill = { color: color(el.fill), transparency: 100 }
    opts.line.color = color(el.fill)
    opts.line.beginArrowType = arrow(el.lineStart)
    opts.line.endArrowType = arrow(el.lineEnd)
  }
  slide.addShape(shape, opts)
}

async function addImage(slide: any, el: ImageElement, doc: BentoDoc, box: any) {
  const src = await resolveAsset(el.src, doc)
  if (!src) return
  const fit = el.fit === 'fill' ? undefined : { type: el.fit, w: box.w, h: box.h }
  slide.addImage({ data: src, ...box, sizing: fit, transparency: opacity(el.opacity), rounding: el.radius >= Math.min(el.w, el.h) / 2 })
}

function addSvg(slide: any, el: SvgElement, doc: BentoDoc, box: any) {
  const markup = el.asset ? doc.assets?.[el.asset] : el.markup
  if (!markup) return
  const svg = markup.startsWith('data:') ? markup : `data:image/svg+xml;base64,${utf8b64(markup)}`
  slide.addImage({ data: svg, ...box, transparency: opacity(el.opacity) })
}

function addTable(slide: any, el: TableElement, box: any) {
  const rows = el.rows.map((row, r) => row.cells.map((cell) => ({
    text: htmlText(cell.html),
    options: {
      bold: cell.bold || (el.header && r === 0), align: cell.align || 'left',
      color: color(cell.color || (el.header && r === 0 ? el.style.headerColor : el.style.color)),
      fill: { color: color(cell.bg || (el.header && r === 0 ? el.style.headerBg : r % 2 && el.style.zebra ? el.style.zebra : 'FFFFFF')), transparency: opacity(el.opacity) },
      margin: [el.style.cellPadY * .01, el.style.cellPadX * .01],
    },
  })))
  const sum = el.columns.reduce((n, c) => n + c.w, 0) || 1
  slide.addTable(rows, {
    ...box, fontFace: fontFace(el.style.fontFamily || ''), fontSize: el.style.fontSize * .75,
    border: { pt: el.style.borderWidth * .75, color: color(el.style.borderColor) },
    colW: el.columns.map((c) => box.w * c.w / sum), rowH: box.h / Math.max(1, rows.length),
    autoFit: false, breakLine: false,
  })
}

function addChart(pptx: PptxGenJS, slide: any, el: ChartElement, box: any) {
  const option: any = el.option
  const series = Array.isArray(option.series) ? option.series : []
  if (!series.length) return
  const labels = Array.isArray(option.xAxis?.data) ? option.xAxis.data.map(String) : series[0]?.data?.map((d: any) => String(d?.name ?? '')) ?? []
  const data = series.map((s: any, i: number) => ({
    name: String(s.name ?? `Series ${i + 1}`), labels,
    values: (s.data ?? []).map((v: any) => Number(v?.value ?? v) || 0),
  }))
  const kind = series[0]?.type === 'pie' ? pptx.ChartType.pie : series[0]?.type === 'line' ? pptx.ChartType.line : pptx.ChartType.bar
  slide.addChart(kind, data, { ...box, showLegend: series.length > 1, showTitle: false, showValue: false, border: { color: 'transparent', pt: 0 }, chartColors: option.color?.map(color) })
}

async function resolveAsset(src: string, doc: BentoDoc): Promise<string | null> {
  const value = src.startsWith('asset:') ? doc.assets?.[src.slice(6)] : src
  if (!value) return null
  if (value.startsWith('data:')) return value
  if (value.trimStart().startsWith('<svg')) return `data:image/svg+xml;base64,${utf8b64(value)}`
  try {
    const response = await fetch(value)
    if (!response.ok) return null
    const blob = await response.blob()
    return await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(blob) })
  } catch { return null }
}

function htmlText(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html.replace(/<br\s*\/?>/gi, '\n')}</body>`, 'text/html')
  return doc.body.textContent?.replace(/\u00a0/g, ' ').trim() ?? ''
}
function color(css: string): string { return css?.match(/#([0-9a-f]{6})/i)?.[1].toUpperCase() || '000000' }
function opacity(value: number): number { return Math.round((1 - Math.max(0, Math.min(1, value ?? 1))) * 100) }
function fontFace(stack: string): string {
  const names = stack.split(',').map((v) => v.replace(/["']/g, '').trim()).filter(Boolean)
  // CSS-only aliases are not PowerPoint fonts. Prefer a concrete cross-office
  // face; for CJK stacks choose the explicit platform font when available.
  const concrete = names.find((v) => !/^(-apple-system|BlinkMacSystemFont|sans-serif|serif|system-ui)$/i.test(v))
  if (!concrete) return 'Arial'
  if (/^Segoe UI$/i.test(concrete)) return 'Arial'
  return concrete
}
function arrow(v?: string): string | undefined { return v === 'arrow' ? 'triangle' : v === 'dot' ? 'oval' : v === 'bar' ? 'line' : undefined }
function utf8b64(value: string): string { const bytes = new TextEncoder().encode(value); let raw = ''; for (const b of bytes) raw += String.fromCharCode(b); return btoa(raw) }
