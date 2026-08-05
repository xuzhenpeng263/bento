// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The WebDeck authors
// GPU particle engine — tens of thousands of particles at 60fps.
//
// WebGL instanced-points renderer: one draw call for all particles,
// CPU-side Float32Array physics, OffscreenCanvas text sampling.
//
// Usage:
//   const eng = createParticleEngine(canvas, 1280, 720)
//   eng.emit({ count: 20000, x: 640, y: 360, spread: 400, color: '#ff9e8a' })
//   eng.flyTo(positions, { duration: 0.8 })
//   // in rAF: eng.update(dt); eng.render()

// --- WebGL shaders ------------------------------------------------------------

const VERT = `attribute vec2 a_pos;
attribute float a_size;
attribute vec4 a_color;
uniform vec2 u_res;
varying vec4 v_color;
void main() {
  gl_Position = vec4((a_pos / u_res) * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = a_size;
  v_color = a_color;
}`

const FRAG = `precision mediump float;
varying vec4 v_color;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = 1.0 - smoothstep(0.25, 1.0, d);
  gl_FragColor = vec4(v_color.rgb, v_color.a * a);
}`

// --- helpers ------------------------------------------------------------------

const FLOATS_PER_PARTICLE = 10 // x, y, vx, vy, life, size, r, g, b, a
const BYTES_PER_PARTICLE = FLOATS_PER_PARTICLE * 4

function hexToRGBA(hex: string): [number, number, number, number] {
  let h = hex.trim()
  if (/^#[0-9a-fA-F]{3}$/.test(h)) h = '#' + [...h.slice(1)].map((c) => c + c).join('')
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})?$/.exec(h)
  if (!m) return [1, 1, 1, 1]
  return [
    parseInt(m[1], 16) / 255,
    parseInt(m[2], 16) / 255,
    parseInt(m[3], 16) / 255,
    m[4] ? parseInt(m[4], 16) / 255 : 1,
  ]
}

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const err = gl.getShaderInfoLog(s)
    gl.deleteShader(s)
    throw new Error('shader: ' + (err ?? 'unknown error'))
  }
  return s
}

function linkProgram(gl: WebGLRenderingContext, vert: WebGLShader, frag: WebGLShader): WebGLProgram {
  const p = gl.createProgram()!
  gl.attachShader(p, vert)
  gl.attachShader(p, frag)
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const err = gl.getProgramInfoLog(p)
    gl.deleteProgram(p)
    throw new Error('program: ' + (err ?? 'unknown error'))
  }
  return p
}

// --- text sampling ------------------------------------------------------------

export interface TextSample {
  /** World-space positions (x,y pairs interleaved, length = 2 * count) */
  positions: Float32Array
  count: number
  width: number
  height: number
}

/**
 * Render text to an offscreen canvas and extract particle spawn positions
 * from non-transparent pixels.
 */
export function sampleText(
  text: string,
  opts: {
    font?: string
    density?: number // 1 = every pixel, 0.25 = every 4th pixel
    originX?: number
    originY?: number
  } = {},
): TextSample {
  const font = opts.font ?? 'bold 64px sans-serif'
  const density = Math.max(0.05, Math.min(1, opts.density ?? 0.5))
  const step = Math.max(1, Math.round(1 / density))

  // Measure first
  const measure = document.createElement('canvas')
  measure.width = 1; measure.height = 1
  const mc = measure.getContext('2d')!
  mc.font = font
  const metrics = mc.measureText(text)
  const tw = Math.ceil(metrics.width)
  const th = Math.ceil((metrics as any).fontBoundingBoxAscent + (metrics as any).fontBoundingBoxDescent || 80)

  const w = tw + 8
  const h = th + 8
  const ox = opts.originX ?? 0
  const oy = opts.originY ?? 0

  // Render
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const ctx = c.getContext('2d')!
  ctx.font = font
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'top'
  ctx.fillText(text, 4, 4)

  // Sample non-transparent pixels
  const img = ctx.getImageData(0, 0, w, h)
  const pixels = img.data
  const pts: number[] = []
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4
      if (pixels[i + 3] > 30) { // alpha > 30/255
        pts.push(x + ox - tw / 2 - 4, y + oy - th / 2 - 4)
      }
    }
  }

  return {
    positions: new Float32Array(pts),
    count: pts.length / 2,
    width: tw,
    height: th,
  }
}

// --- particle engine ----------------------------------------------------------

export interface EmitOpts {
  count: number
  x: number
  y: number
  spread?: number
  color?: string
  life?: number
  speed?: number
  size?: number
}

export interface FlyToOpts {
  duration?: number
}

export interface ParticleState {
  /** Interleaved: x, y, vx, vy, life, size, r, g, b, a per particle */
  data: Float32Array
  count: number
  capacity: number
  target?: Float32Array // target positions for fly-to
  targetCount: number
  flyProgress: number
  flyDuration: number
}

export interface ParticleEngine {
  emit(opts: EmitOpts): void
  emitAt(positions: Float32Array, opts?: { color?: string; size?: number; life?: number }): void
  flyTo(positions: Float32Array, opts?: FlyToOpts): void
  update(dt: number): void
  render(): void
  resize(w: number, h: number): void
  dispose(): void
  get count(): number
}

export function createParticleEngine(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  initialCapacity = 50000,
): ParticleEngine {
  const rawGl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true })
  if (!rawGl) throw new Error('particles: WebGL not available')
  const gl: WebGLRenderingContext = rawGl

  const vert = compileShader(gl, gl.VERTEX_SHADER, VERT)
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, FRAG)
  const prog = linkProgram(gl, vert, frag)

  const aPos = gl.getAttribLocation(prog, 'a_pos')
  const aSize = gl.getAttribLocation(prog, 'a_size')
  const aColor = gl.getAttribLocation(prog, 'a_color')
  const uRes = gl.getUniformLocation(prog, 'u_res')

  // Particle buffer
  let capacity = Math.max(256, initialCapacity)
  let data = new Float32Array(capacity * FLOATS_PER_PARTICLE)
  let buffer = gl.createBuffer()!
  let count = 0

  // Target buffer for fly-to
  let targetBuf: Float32Array | null = null
  let targetCount = 0
  let flyProgress = 0
  let flyDuration = 0.8
  let flyActive = false

  function ensureCapacity(needed: number) {
    if (needed <= capacity) return
    while (capacity < needed) capacity *= 2
    const next = new Float32Array(capacity * FLOATS_PER_PARTICLE)
    next.set(data)
    data = next
  }

  function upload() {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, count * FLOATS_PER_PARTICLE), gl.DYNAMIC_DRAW)
  }

  function emit(opts: EmitOpts) {
    const n = opts.count
    ensureCapacity(count + n)
    const spread = opts.spread ?? 200
    const color = hexToRGBA(opts.color ?? '#ff9e8a')
    const life = opts.life ?? 1.5 + Math.random() * 1.0
    const speed = opts.speed ?? 600
    const size = opts.size ?? 4

    const base = count * FLOATS_PER_PARTICLE
    for (let i = 0; i < n; i++) {
      const j = base + i * FLOATS_PER_PARTICLE
      const angle = Math.random() * Math.PI * 2
      const mag = Math.random() * speed
      data[j] = opts.x + (Math.random() - 0.5) * spread   // x
      data[j + 1] = opts.y + (Math.random() - 0.5) * spread // y
      data[j + 2] = Math.cos(angle) * mag                 // vx
      data[j + 3] = Math.sin(angle) * mag                 // vy
      data[j + 4] = life * (0.6 + Math.random() * 0.8)    // life
      data[j + 5] = size * (0.5 + Math.random())          // size
      data[j + 6] = color[0]                              // r
      data[j + 7] = color[1]                              // g
      data[j + 8] = color[2]                              // b
      data[j + 9] = color[3]                              // a
    }
    count += n
    upload()
  }

  /** Spawn particles at specific (x,y) positions. */
  function emitAt(positions: Float32Array, opts: { color?: string; size?: number; life?: number } = {}) {
    const n = positions.length / 2
    ensureCapacity(count + n)
    const color = hexToRGBA(opts.color ?? '#ff9e8a')
    const size = opts.size ?? 3
    const life = opts.life ?? 1.5

    const base = count * FLOATS_PER_PARTICLE
    for (let i = 0; i < n; i++) {
      const j = base + i * FLOATS_PER_PARTICLE
      data[j] = positions[i * 2]          // x
      data[j + 1] = positions[i * 2 + 1]  // y
      data[j + 2] = (Math.random() - 0.5) * 60 // vx (small jitter)
      data[j + 3] = (Math.random() - 0.5) * 60 // vy
      data[j + 4] = life * (0.8 + Math.random() * 0.4)
      data[j + 5] = size * (0.7 + Math.random() * 0.6)
      data[j + 6] = color[0]
      data[j + 7] = color[1]
      data[j + 8] = color[2]
      data[j + 9] = color[3]
    }
    count += n
    upload()
  }

  function flyTo(positions: Float32Array, opts: FlyToOpts = {}) {
    targetCount = positions.length / 2
    targetBuf = new Float32Array(positions)
    flyDuration = opts.duration ?? 0.8
    flyProgress = 0
    flyActive = true
  }

  function update(dt: number) {
    if (count === 0) return

    dt = Math.min(dt, 0.1) // clamp for tab switches
    let alive = 0

    for (let i = 0; i < count; i++) {
      const j = i * FLOATS_PER_PARTICLE
      const life = data[j + 4] - dt
      if (life <= 0) {
        // Dead — will be compacted below
        continue
      }
      data[j + 4] = life

      // Movement: if fly-to is active, blend toward target
      if (flyActive && targetBuf && flyDuration > 0) {
        flyProgress = Math.min(1, flyProgress + dt / flyDuration)
        // Ease-out cubic used to scale the attraction force
        const easeT = 1 - Math.pow(1 - flyProgress, 3)

        if (i < targetCount) {
          const tx = targetBuf[i * 2]
          const ty = targetBuf[i * 2 + 1]
          // Spring-like attraction, eased over fly progress
          const dx = tx - data[j]
          const dy = ty - data[j + 1]
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist > 1) {
            const force = 8.0 * easeT
            data[j + 2] += (dx / dist) * force * dt * 200
            data[j + 3] += (dy / dist) * force * dt * 200
          }
        }
        // Damping
        data[j + 2] *= 0.95
        data[j + 3] *= 0.95
      }

      // Integrate position
      data[j] += data[j + 2] * dt
      data[j + 1] += data[j + 3] * dt

      // Fade alpha based on remaining life fraction
      const maxLife = 2.0 // approximate
      data[j + 9] = Math.min(1, life / (maxLife * 0.5))

      // Compact alive particles to front
      if (alive !== i) {
        const d = alive * FLOATS_PER_PARTICLE
        const s = j
        for (let k = 0; k < FLOATS_PER_PARTICLE; k++) data[d + k] = data[s + k]
      }
      alive++
    }

    const died = count - alive
    count = alive
    if (died > 0 || flyProgress < 1) upload()
  }

  function render() {
    if (count === 0) return

    gl!.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.useProgram(prog)
    gl.uniform2f(uRes, canvas.width, canvas.height)

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)

    const stride = BYTES_PER_PARTICLE
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, stride, 0)

    gl.enableVertexAttribArray(aSize)
    gl.vertexAttribPointer(aSize, 1, gl.FLOAT, false, stride, 20) // offset 5*4

    gl.enableVertexAttribArray(aColor)
    gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, stride, 24) // offset 6*4

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    gl.drawArrays(gl.POINTS, 0, count)
  }

  function resize(w: number, h: number) {
    canvas.width = w
    canvas.height = h
  }

  function dispose() {
    gl.deleteProgram(prog)
    gl.deleteShader(vert)
    gl.deleteShader(frag)
    gl.deleteBuffer(buffer)
  }

  resize(width, height)

  return { emit, emitAt, flyTo, update, render, resize, dispose, get count() { return count } }
}
