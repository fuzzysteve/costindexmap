// Cost index history map — WebGPU renderer and controls.
// Data: data/meta.bin and data/ci-<activity>.bin, built by build.php.
'use strict';

const $ = (id) => document.getElementById(id);
const VERSION = window.CIMAP?.dataVersion ?? 0;
const FOV = 45 * Math.PI / 180;
const PITCH_MIN = 0.06, PITCH_MAX = 1.565;
const DIST_MIN = 0.4, DIST_MAX = 600;
// Display range of the colour scale. Values run 0.04%..52%; the 0.14% floor came later.
const SHOW_MIN = 0.0005, SHOW_MAX = 0.2;
// matplotlib "inferno", 11 stops.
const INFERNO = ['#000004', '#160b39', '#420a68', '#6a176e', '#932667', '#bc3754',
  '#dd513a', '#f37819', '#fca50a', '#f6d746', '#fcffa4'];
// The dimmest part of inferno vanishes on the background, so points start here.
const RAMP_FLOOR = 0.14;

// ---------------------------------------------------------------- state
const S = {
  meta: null, N: 0, D: 0, start: 0, missing: new Set(),
  pos: null,                 // Float32Array xyz per system (light years)
  regionOf: null, regionNames: [], regionCenters: [],
  activity: 1, act: null,    // act = {data: Uint8Array, bind}
  cache: new Map(),
  t: 0, playing: false, speed: 30,
  cam: { target: [0, 0, 0], dist: 120, yaw: 0, pitch: 1.1 },
  fly: null,
  sel: -1, hov: -1,
  showGates: true, showLabels: true, loop: false, glow: 1,
  dirty: true, lastDay: -1,
  vp: new Float32Array(16), basis: null,
  cssW: 1, cssH: 1, dpr: 1,
};
let device, ctx, format, uniformBuf, posBuf, edgeBuf, edgeCount = 0, bindLayout, ptsPipe, linePipe;
const ub = new ArrayBuffer(112);
const uf = new Float32Array(ub), uu = new Uint32Array(ub), ui = new Int32Array(ub);

// ---------------------------------------------------------------- helpers
function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

async function loadBin(url, label) {
  setStatus(`Loading ${label}…`);
  const r = await fetch(`${url}?v=${VERSION}`);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const total = +r.headers.get('Content-Length') || 0;
  let got = 0;
  const progress = new TransformStream({
    transform(chunk, ctl) {
      got += chunk.byteLength;
      if (total) setStatus(`Loading ${label}… ${Math.round(got / total * 100)}%`);
      ctl.enqueue(chunk);
    },
  });
  const raw = new Uint8Array(await new Response(r.body.pipeThrough(progress)).arrayBuffer());
  // Files are gzip; a server that already decoded them (Content-Encoding) is fine too.
  if (raw[0] !== 0x1f || raw[1] !== 0x8b) return raw;
  const ds = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(ds).arrayBuffer());
}

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// Byte (1..255) <-> cost index value, matching build.php.
let LN_MIN, LN_SPAN;
const qToValue = (q) => (q ? Math.exp(LN_MIN + (q - 1) / 254 * LN_SPAN) : null);
const valueToN = (v) => (Math.log(v) - LN_MIN) / LN_SPAN;          // 0..1 in byte space
const tLo = () => valueToN(SHOW_MIN), tHi = () => valueToN(SHOW_MAX);
const valueToT = (v) => clamp((valueToN(v) - tLo()) / (tHi() - tLo()), 0, 1);
const fmtPct = (v) => (v == null ? '—' : `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`);

function rampCss(t) {
  const x = clamp(RAMP_FLOOR + (1 - RAMP_FLOOR) * t, 0, 1) * 10;
  const i = Math.floor(x), j = Math.min(i + 1, 10), f = x - i;
  const a = hexRgb(INFERNO[i]), b = hexRgb(INFERNO[j]);
  return `rgb(${a.map((c, k) => Math.round(lerp(c, b[k], f) * 255)).join(',')})`;
}

function dayDate(d) {
  return new Date(S.start + d * 86400000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- matrices (column-major)
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function camEye(c) {
  const cp = Math.cos(c.pitch);
  return [c.target[0] + c.dist * cp * Math.sin(c.yaw),
    c.target[1] + c.dist * Math.sin(c.pitch),
    c.target[2] + c.dist * cp * Math.cos(c.yaw)];
}

function updateMatrices() {
  const c = S.cam, e = camEye(c);
  const f = norm(sub(c.target, e));
  const s = norm(cross(f, [0, 1, 0]));
  const u = cross(s, f);
  const view = [s[0], u[0], -f[0], 0, s[1], u[1], -f[1], 0, s[2], u[2], -f[2], 0,
    -dot(s, e), -dot(u, e), dot(f, e), 1];
  const near = c.dist * 0.01, far = c.dist * 50 + 300;
  const fy = 1 / Math.tan(FOV / 2), aspect = S.cssW / S.cssH;
  const proj = [fy / aspect, 0, 0, 0, 0, fy, 0, 0, 0, 0, far / (near - far), -1, 0, 0, near * far / (near - far), 0];
  for (let col = 0; col < 4; col++) {
    for (let r = 0; r < 4; r++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += proj[k * 4 + r] * view[col * 4 + k];
      S.vp[col * 4 + r] = v;
    }
  }
  S.basis = { e, f, s, u };
}

// World point -> CSS pixel position (or null if behind the camera).
function project(x, y, z) {
  const m = S.vp;
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (w <= 1e-6) return null;
  const px = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  const py = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  return [(px + 1) / 2 * S.cssW, (1 - py) / 2 * S.cssH, w];
}

// Point on the horizontal plane through the camera target under a CSS pixel.
function groundUnder(cx, cy) {
  const { e, f, s, u } = S.basis;
  const th = Math.tan(FOV / 2), aspect = S.cssW / S.cssH;
  const nx = (cx / S.cssW) * 2 - 1, ny = 1 - (cy / S.cssH) * 2;
  const d = [0, 1, 2].map((i) => f[i] + s[i] * nx * th * aspect + u[i] * ny * th);
  if (Math.abs(d[1]) < 1e-4) return null;
  const k = (S.cam.target[1] - e[1]) / d[1];
  if (k <= 0) return null;
  return [e[0] + d[0] * k, S.cam.target[1], e[2] + d[2] * k];
}

// ---------------------------------------------------------------- WebGPU
const RAMP_WGSL = INFERNO.map((h) => `vec3f(${hexRgb(h).map((c) => c.toFixed(4)).join(',')})`).join(',\n  ');
const SHADER = /* wgsl */`
struct U {
  vp: mat4x4f,
  viewport: vec2f,
  day0: u32,
  day1: u32,
  frac: f32,
  size: f32,
  sel: i32,
  hov: i32,
  gain: f32,
  lineGain: f32,
  tLo: f32,
  tHi: f32,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> pos: array<f32>;
@group(0) @binding(2) var tex: texture_2d<f32>;
@group(0) @binding(3) var<storage, read> edges: array<u32>;

const RAMP = array<vec3f, 11>(
  ${RAMP_WGSL}
);

fn ramp(t: f32) -> vec3f {
  var r = RAMP;
  let x = clamp(${RAMP_FLOOR} + ${(1 - RAMP_FLOOR).toFixed(4)} * t, 0.0, 1.0) * 10.0;
  let i = min(u32(floor(x)), 10u);
  let j = min(i + 1u, 10u);
  return mix(r[i], r[j], x - f32(i));
}

fn sysPos(i: u32) -> vec3f {
  return vec3f(pos[i * 3u], pos[i * 3u + 1u], pos[i * 3u + 2u]);
}

// (t, hasData): t is the 0..1 colour-scale position, interpolated between days.
fn level(i: u32) -> vec2f {
  let a = textureLoad(tex, vec2u(i, u.day0), 0).r * 255.0;
  let b = textureLoad(tex, vec2u(i, u.day1), 0).r * 255.0;
  if (a < 0.5 && b < 0.5) { return vec2f(0.0, 0.0); }
  let qa = select(a, b, a < 0.5);
  let qb = select(b, a, b < 0.5);
  let n = (mix(qa, qb, u.frac) - 1.0) / 254.0;
  return vec2f(clamp((n - u.tLo) / (u.tHi - u.tLo), 0.0, 1.0), 1.0);
}

struct PO {
  @builtin(position) p: vec4f,
  @location(0) uv: vec2f,
  @location(1) t: f32,
  @location(2) has: f32,
  @location(3) hl: f32,
};

@vertex fn vsPts(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> PO {
  var corners = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1),
                                vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1));
  let c = corners[vi];
  let lv = level(ii);
  let clip = u.vp * vec4f(sysPos(ii), 1.0);
  var sz = u.size * select(0.5, 0.75 + 2.6 * lv.x * lv.x, lv.y > 0.5);
  var hl = 0.0;
  if (i32(ii) == u.sel || i32(ii) == u.hov) {
    sz = max(sz * 1.5, u.size * 2.6);
    hl = 1.0;
  }
  var o: PO;
  o.p = clip + vec4f(c * sz * 2.0 / u.viewport * clip.w, 0.0, 0.0);
  if (clip.w <= 0.0) { o.p = vec4f(2.0, 2.0, 2.0, 1.0); }
  o.uv = c;
  o.t = lv.x;
  o.has = lv.y;
  o.hl = hl;
  return o;
}

@fragment fn fsPts(i: PO) -> @location(0) vec4f {
  let r2 = dot(i.uv, i.uv);
  if (r2 > 1.0) { discard; }
  if (i.hl > 0.5 && r2 > 0.78) { return vec4f(0.85, 0.9, 1.0, 1.0); }
  let a = exp(-r2 * 4.5);
  var col = ramp(i.t) * (0.45 + 0.75 * i.t);
  if (i.has < 0.5) { col = vec3f(0.12, 0.13, 0.16); }
  return vec4f(col * a * u.gain, 1.0);
}

struct LO {
  @builtin(position) p: vec4f,
  @location(0) t: f32,
};

@vertex fn vsLine(@builtin(vertex_index) vi: u32) -> LO {
  let i = edges[vi];
  var o: LO;
  o.p = u.vp * vec4f(sysPos(i), 1.0);
  o.t = level(i).x;
  return o;
}

@fragment fn fsLine(i: LO) -> @location(0) vec4f {
  let col = mix(vec3f(0.06, 0.08, 0.14), ramp(i.t) * 0.35, i.t);
  return vec4f(col * u.lineGain, 1.0);
}
`;

async function initGpu() {
  if (!navigator.gpu) throw new Error('This map needs WebGPU. Try a current Chrome, Edge or Safari, or Firefox on Windows.');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU is available but no GPU adapter was found (it may be disabled or blocklisted).');
  const needH = S.D, needW = S.N;
  const lim = adapter.limits.maxTextureDimension2D;
  if (needH > lim || needW > lim) throw new Error(`This GPU's texture limit (${lim}) is too small for ${needW}×${needH}.`);
  device = await adapter.requestDevice({
    requiredLimits: { maxTextureDimension2D: Math.max(8192, needH, needW) > 8192 ? lim : 8192 },
  });
  device.lost.then((info) => { if (info.reason !== 'destroyed') setStatus(`GPU device lost: ${info.message}. Reload the page.`, true); });
  device.addEventListener('uncapturederror', (e) => console.error('WebGPU error:', e.error.message));

  const canvas = $('gpu');
  ctx = canvas.getContext('webgpu');
  format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });

  uniformBuf = device.createBuffer({ size: ub.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  posBuf = device.createBuffer({ size: S.pos.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(posBuf, 0, S.pos);
  const edges = new Uint32Array(S.meta.jumps);
  edgeCount = edges.length;
  edgeBuf = device.createBuffer({ size: Math.max(16, edges.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(edgeBuf, 0, edges);

  bindLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'unfilterable-float' } },
      { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ],
  });
  const module = device.createShaderModule({ code: SHADER });
  const info = await module.getCompilationInfo();
  const errs = info.messages.filter((m) => m.type === 'error');
  if (errs.length) throw new Error('Shader error: ' + errs.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; '));

  const layout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] });
  const additive = {
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  };
  ptsPipe = device.createRenderPipeline({
    layout,
    vertex: { module, entryPoint: 'vsPts' },
    fragment: { module, entryPoint: 'fsPts', targets: [{ format, blend: additive }] },
    primitive: { topology: 'triangle-list' },
  });
  linePipe = device.createRenderPipeline({
    layout,
    vertex: { module, entryPoint: 'vsLine' },
    fragment: { module, entryPoint: 'fsLine', targets: [{ format, blend: additive }] },
    primitive: { topology: 'line-list' },
  });

  new ResizeObserver(resize).observe(canvas);
  resize();
}

function resize() {
  const canvas = $('gpu');
  S.dpr = Math.min(window.devicePixelRatio || 1, 2);
  S.cssW = Math.max(1, canvas.clientWidth);
  S.cssH = Math.max(1, canvas.clientHeight);
  canvas.width = Math.round(S.cssW * S.dpr);
  canvas.height = Math.round(S.cssH * S.dpr);
  S.dirty = true;
}

async function loadActivity(id) {
  S.activity = id;
  let entry = S.cache.get(id);
  if (!entry) {
    const name = S.meta.activities.find((a) => a.id === id)?.name ?? id;
    const data = await loadBin(`data/ci-${id}.bin`, name.toLowerCase());
    if (data.length !== S.N * S.D) throw new Error(`ci-${id}.bin: expected ${S.N * S.D} bytes, got ${data.length}`);
    // Undo the per-day XOR delta from build.php.
    const N = S.N;
    for (let k = N; k < data.length; k++) data[k] ^= data[k - N];
    const tex = device.createTexture({ size: [S.N, S.D], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: S.N, rowsPerImage: S.D }, [S.N, S.D]);
    const bind = device.createBindGroup({
      layout: bindLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuf } },
        { binding: 1, resource: { buffer: posBuf } },
        { binding: 2, resource: tex.createView() },
        { binding: 3, resource: { buffer: edgeBuf } },
      ],
    });
    entry = { data, bind };
    S.cache.set(id, entry);
    setStatus('');
  }
  if (S.activity !== id) return;   // a later choice won the race
  S.act = entry;
  S.lastDay = -1;
  S.dirty = true;
  if (S.sel >= 0) drawSpark(true);
}

// ---------------------------------------------------------------- values
const dayIndex = () => clamp(Math.floor(S.t), 0, S.D - 1);
function valueAt(sys, day = dayIndex()) {
  return S.act ? qToValue(S.act.data[day * S.N + sys]) : null;
}

// ---------------------------------------------------------------- camera
function fitBox(indices) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const i of indices) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], S.pos[i * 3 + k]);
      hi[k] = Math.max(hi[k], S.pos[i * 3 + k]);
    }
  }
  const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  let r = 0;
  for (const i of indices) r = Math.max(r, Math.hypot(S.pos[i * 3] - c[0], S.pos[i * 3 + 1] - c[1], S.pos[i * 3 + 2] - c[2]));
  const half = Math.min(FOV / 2, Math.atan(Math.tan(FOV / 2) * S.cssW / S.cssH));
  return { target: c, dist: clamp(Math.max(r, 1.5) / Math.sin(half) * 1.1, DIST_MIN, DIST_MAX) };
}

function flyTo(to, ms = 1100) {
  const from = { ...S.cam, target: [...S.cam.target] };
  const goal = { target: to.target ?? from.target, dist: to.dist ?? from.dist,
    yaw: to.yaw ?? from.yaw, pitch: to.pitch ?? from.pitch };
  let dy = goal.yaw - from.yaw;
  dy = ((dy + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  goal.yaw = from.yaw + dy;
  S.fly = { from, goal, t0: performance.now(), ms };
}

function stepFly(now) {
  const { from, goal, t0, ms } = S.fly;
  const k = ease(clamp((now - t0) / ms, 0, 1));
  S.cam.target = [0, 1, 2].map((i) => lerp(from.target[i], goal.target[i], k));
  S.cam.dist = Math.exp(lerp(Math.log(from.dist), Math.log(goal.dist), k));
  S.cam.yaw = lerp(from.yaw, goal.yaw, k);
  S.cam.pitch = lerp(from.pitch, goal.pitch, k);
  if (k >= 1) S.fly = null;
  S.dirty = true;
}

function resetView(animate = true) {
  const all = Array.from({ length: S.N }, (_, i) => i);
  const fit = fitBox(all);
  const goal = { ...fit, dist: fit.dist * 0.8, yaw: 0, pitch: 1.15 };
  if (animate) flyTo(goal); else Object.assign(S.cam, goal);
  S.dirty = true;
}

function focusSystem(i, select = true) {
  if (select) selectSystem(i);
  const p = [S.pos[i * 3], S.pos[i * 3 + 1], S.pos[i * 3 + 2]];
  flyTo({ target: p, dist: Math.min(S.cam.dist, 6) });
}

function focusRegion(r) {
  const members = [];
  for (let i = 0; i < S.N; i++) if (S.regionOf[i] === r) members.push(i);
  if (members.length) flyTo(fitBox(members));
}

// ---------------------------------------------------------------- input
function initInput() {
  const canvas = $('gpu');
  const pointers = new Map();
  let downAt = null, moved = false, pinch = null;

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    downAt = { x: e.clientX, y: e.clientY, rotate: e.button === 2 || e.shiftKey || e.ctrlKey || e.altKey };
    moved = false;
    pinch = null;
    S.fly = null;
    canvas.classList.add('dragging');
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) { hoverAt(e.clientX, e.clientY); return; }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) moved = true;
    if (pointers.size === 1) {
      if (downAt.rotate) rotate(dx, dy); else pan(dx, dy);
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(b.x - a.x, b.y - a.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
      const cy = (a.y + b.y) / 2;
      if (pinch) {
        S.cam.dist = clamp(S.cam.dist * pinch.d / d, DIST_MIN, DIST_MAX);
        S.cam.yaw -= ang - pinch.ang;
        S.cam.pitch = clamp(S.cam.pitch + (cy - pinch.cy) * 0.006, PITCH_MIN, PITCH_MAX);
      }
      pinch = { d, ang, cy };
      moved = true;
    }
    S.dirty = true;
    $('tooltip').hidden = true;
  });

  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    pinch = null;
    if (!pointers.size) canvas.classList.remove('dragging');
    if (!moved && e.type === 'pointerup' && e.button === 0) {
      hoverAt(e.clientX, e.clientY);
      selectSystem(S.hov);
    }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => { if (!pointers.size) setHover(-1); });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    S.fly = null;
    const step = e.deltaMode === 1 ? e.deltaY * 0.05 : e.deltaY * 0.0015;
    const old = S.cam.dist;
    const next = clamp(old * Math.exp(step), DIST_MIN, DIST_MAX);
    // Zoom towards the point under the cursor.
    const g = groundUnder(e.clientX, e.clientY);
    if (g) {
      const k = 1 - next / old;
      S.cam.target = S.cam.target.map((v, i) => v + (g[i] - v) * k);
    }
    S.cam.dist = next;
    S.dirty = true;
  }, { passive: false });

  canvas.addEventListener('dblclick', (e) => {
    hoverAt(e.clientX, e.clientY);
    if (S.hov >= 0) focusSystem(S.hov);
    else {
      const g = groundUnder(e.clientX, e.clientY);
      flyTo({ target: g ?? S.cam.target, dist: S.cam.dist * 0.4 }, 600);
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof Element && e.target.closest('input:not([type=range]):not([type=checkbox]), select, textarea')) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const step = (e.shiftKey ? 30 : 1) * (e.key === 'ArrowRight' ? 1 : -1);
      setDay(Math.floor(S.t) + step);
    } else if (e.key === 'Home') setDay(0);
    else if (e.key === 'End') setDay(S.D - 1);
    else if (e.key === 'Escape') selectSystem(-1);
  });
}

function pan(dx, dy) {
  const c = S.cam;
  const wpp = 2 * c.dist * Math.tan(FOV / 2) / S.cssH;
  const sy = Math.sin(c.yaw), cyw = Math.cos(c.yaw);
  // Move over the map plane: right is (cos yaw, 0, -sin yaw), screen-up is (-sin yaw, 0, -cos yaw).
  const fwd = wpp / Math.max(Math.sin(c.pitch), 0.25);
  c.target[0] += -dx * wpp * cyw - dy * fwd * sy;
  c.target[2] += dx * wpp * sy - dy * fwd * cyw;
}

function rotate(dx, dy) {
  S.cam.yaw -= dx * 0.006;
  S.cam.pitch = clamp(S.cam.pitch + dy * 0.006, PITCH_MIN, PITCH_MAX);
}

// ---------------------------------------------------------------- hover / select
let screenPos = null;   // Float32Array of css x, y per system (NaN if hidden), refreshed per frame
function hoverAt(cx, cy) {
  if (!screenPos) return;
  let best = -1, bestD = 14 * 14;
  for (let i = 0; i < S.N; i++) {
    const x = screenPos[i * 2];
    if (Number.isNaN(x)) continue;
    const dx = x - cx, dy = screenPos[i * 2 + 1] - cy, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  setHover(best, cx, cy);
}

function setHover(i, cx, cy) {
  const tip = $('tooltip');
  if (i !== S.hov) { S.hov = i; S.dirty = true; }
  $('gpu').classList.toggle('hovering', i >= 0);
  if (i < 0) { tip.hidden = true; return; }
  const m = S.meta.systems;
  tip.innerHTML = `<b>${esc(m.name[i])}</b> <span class="muted">${m.sec[i].toFixed(1)} · ${esc(S.regionNames[S.regionOf[i]])}</span><br>` +
    `<span class="v">${fmtPct(valueAt(i))}</span> <span class="muted">${esc(actName())}, ${dayDate(dayIndex())}</span>`;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${clamp(cx + 14, 4, S.cssW - r.width - 4)}px`;
  tip.style.top = `${clamp(cy + 14, 4, S.cssH - r.height - 4)}px`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const actName = () => S.meta.activities.find((a) => a.id === S.activity)?.name ?? '';

function selectSystem(i) {
  S.sel = i;
  S.dirty = true;
  $('info').hidden = i < 0;
  if (i < 0) return;
  const m = S.meta.systems;
  $('infoName').textContent = m.name[i];
  $('infoMeta').textContent = `${m.sec[i].toFixed(1)} · ${S.regionNames[S.regionOf[i]]}`;
  drawSpark(true);
  updateInfoValue();
}

function updateInfoValue() {
  if (S.sel < 0) return;
  $('infoValue').textContent = `${fmtPct(valueAt(S.sel))} ${actName().toLowerCase()}`;
}

// Sparkline: full history of the selected system, with a marker for the current day.
let sparkBase = null;
function drawSpark(rebuild) {
  const cv = $('spark');
  const dpr = S.dpr, w = Math.round(cv.clientWidth * dpr) || 600, h = Math.round(80 * dpr);
  if (rebuild || !sparkBase || sparkBase.width !== w) {
    sparkBase = new OffscreenCanvas(w, h);
    const g = sparkBase.getContext('2d');
    if (S.sel >= 0 && S.act) {
      // Height uses this system's own (log) range so its ups and downs show;
      // colour uses the map's scale so it matches the dots.
      let lo = Infinity, hi = -Infinity;
      const col = new Float32Array(w).fill(-1);
      for (let d = 0; d < S.D; d++) {
        const v = qToValue(S.act.data[d * S.N + S.sel]);
        if (v == null) continue;
        lo = Math.min(lo, v); hi = Math.max(hi, v);
        const x = Math.floor(d / S.D * w);
        col[x] = Math.max(col[x], v);
      }
      const lnLo = Math.log(lo), lnSpan = Math.max(Math.log(hi) - lnLo, 0.05);
      g.fillStyle = 'rgba(255,255,255,0.05)';
      for (const d of S.missing) g.fillRect(Math.floor(d / S.D * w), 0, Math.max(1, w / S.D), h);
      for (let x = 0; x < w; x++) {
        if (col[x] < 0) continue;
        const y = h - 2 - (0.08 + 0.92 * (Math.log(col[x]) - lnLo) / lnSpan) * (h - 6);
        g.fillStyle = rampCss(valueToT(col[x]));
        g.fillRect(x, y, 1, h - y);
      }
      $('sparkRange').textContent = Number.isFinite(lo)
        ? `${dayDate(0).slice(0, 4)}–${dayDate(S.D - 1).slice(0, 4)}: ${fmtPct(lo)} to ${fmtPct(hi)} (log scale)` : 'No data for this system.';
    }
  }
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, h);
  g.drawImage(sparkBase, 0, 0);
  const x = Math.floor(S.t / S.D * w);
  g.fillStyle = '#ffffff';
  g.fillRect(x, 0, Math.max(1, dpr), h);
}

// ---------------------------------------------------------------- top list
function updateTop() {
  if (!S.act) return;
  const d = dayIndex(), N = S.N, row = S.act.data.subarray(d * N, d * N + N);
  const top = [];
  for (let i = 0; i < N; i++) {
    const q = row[i];
    if (top.length < 10 || q > top[top.length - 1].q) {
      top.push({ i, q });
      top.sort((a, b) => b.q - a.q);
      if (top.length > 10) top.pop();
    }
  }
  const m = S.meta.systems;
  $('top').innerHTML = top.filter((x) => x.q).map(({ i, q }) =>
    `<li data-i="${i}"><span class="name">${esc(m.name[i])} <small>${esc(S.regionNames[S.regionOf[i]])}</small></span>` +
    `<span class="val">${fmtPct(qToValue(q))}</span></li>`).join('');
}

// ---------------------------------------------------------------- labels
const labelPool = [];
function label(k) {
  let el = labelPool[k];
  if (!el) { el = document.createElement('div'); $('labels').appendChild(el); labelPool[k] = el; }
  return el;
}

function updateLabels() {
  // Greedy placement: selected system, then regions, then systems busiest
  // first; anything that would overlap an already placed label is skipped.
  const placed = [];
  const fits = (x, y, w, h) => {
    for (const r of placed) if (x < r[2] && x + w > r[0] && y < r[3] && y + h > r[1]) return false;
    placed.push([x, y, x + w, y + h]);
    return true;
  };
  let k = 0;
  const put = (cls, text, x, y, opacity = '') => {
    const el = label(k++);
    el.className = cls;
    el.textContent = text;
    el.style.opacity = opacity;
    el.style.transform = `translate(${x}px, ${y}px)`;
  };
  const names = S.meta.systems.name;

  if (S.sel >= 0 && !Number.isNaN(screenPos[S.sel * 2])) {
    const x = screenPos[S.sel * 2] + 9, y = screenPos[S.sel * 2 + 1] - 17;
    fits(x, y, names[S.sel].length * 7.5, 16);
    put('system sel', names[S.sel], x, y);
  }
  if (S.showLabels) {
    if (S.cam.dist > 9) {
      const fade = clamp((S.cam.dist - 9) / 10, 0, 1);
      // Busiest regions (summed index today) claim their label space first.
      const busy = new Float64Array(S.regionCenters.length);
      if (S.act) {
        const row = dayIndex() * S.N;
        for (let i = 0; i < S.N; i++) busy[S.regionOf[i]] += S.act.data[row + i];
      }
      const order = [...busy.keys()].sort((a, b) => busy[b] - busy[a]);
      for (const r of order) {
        const c = S.regionCenters[r], p = project(c[0], c[1], c[2]);
        if (!p || p[0] < -80 || p[0] > S.cssW + 80 || p[1] < -20 || p[1] > S.cssH + 20) continue;
        const w = S.regionNames[r].length * 8.2, x = p[0] - w / 2, y = p[1] - 7;
        if (fits(x, y, w, 14)) put('region', S.regionNames[r], x, y, fade);
      }
    }
    const visible = [];
    for (let i = 0; i < S.N; i++) if (!Number.isNaN(screenPos[i * 2]) && i !== S.sel) visible.push(i);
    if (visible.length <= 220 && S.act) {
      const row = dayIndex() * S.N;
      visible.sort((a, b) => S.act.data[row + b] - S.act.data[row + a]);
      for (const i of visible) {
        const x = screenPos[i * 2] + 6, y = screenPos[i * 2 + 1] - 13;
        if (fits(x, y, names[i].length * 6.2, 13)) put('system', names[i], x, y);
      }
    }
  }
  for (let j = k; j < labelPool.length; j++) labelPool[j].style.transform = 'translate(-9999px, 0)';
}

function updateScreenPos() {
  if (!screenPos) screenPos = new Float32Array(S.N * 2);
  for (let i = 0; i < S.N; i++) {
    const p = project(S.pos[i * 3], S.pos[i * 3 + 1], S.pos[i * 3 + 2]);
    const ok = p && p[0] >= -20 && p[0] <= S.cssW + 20 && p[1] >= -20 && p[1] <= S.cssH + 20;
    screenPos[i * 2] = ok ? p[0] : NaN;
    screenPos[i * 2 + 1] = ok ? p[1] : NaN;
  }
}

// ---------------------------------------------------------------- time
function setDay(d) {
  S.t = clamp(d, 0, S.D - 1);
  S.dirty = true;
}

function togglePlay(force) {
  S.playing = force ?? !S.playing;
  if (S.playing && S.t >= S.D - 1) S.t = 0;
  $('play').textContent = S.playing ? '❚❚' : '▶';
  $('play').setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
  S.dirty = true;
}

function speedFromSlider(v) { return Math.round(10 ** (v / 100 * 3)); }   // 1..1000 days/s
function setSpeedLabel() {
  const s = S.speed;
  $('speedLabel').textContent = s >= 365 ? `${(s / 365).toFixed(1)} yr/s` : s >= 30 ? `${(s / 30.4).toFixed(1)} mo/s` : `${s} days/s`;
}

let topTimer = 0;
function onDayChange(d, now) {
  $('date').textContent = dayDate(d);
  $('gap').hidden = !S.missing.has(d);
  if (document.activeElement !== $('timeline')) $('timeline').value = d;
  updateInfoValue();
  if (S.sel >= 0) drawSpark(false);
  // The top list is DOM work; ~8 times a second is plenty while playing.
  if (!S.playing || now - topTimer > 120) { updateTop(); topTimer = now; }
}

// ---------------------------------------------------------------- frame
let lastNow = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;
  if (S.playing) {
    S.t += dt * S.speed;
    if (S.t >= S.D - 1) {
      if (S.loop) S.t = 0;
      else { S.t = S.D - 1; togglePlay(false); }
    }
    S.dirty = true;
  }
  if (S.fly) stepFly(now);

  if (S.dirty && S.act) {
    S.dirty = false;
    updateMatrices();
    updateScreenPos();
    const d0 = dayIndex(), d1 = Math.min(d0 + 1, S.D - 1);
    if (d0 !== S.lastDay) { S.lastDay = d0; onDayChange(d0, now); }
    render(d0, d1, S.playing ? S.t - d0 : 0);
    updateLabels();
  }
  requestAnimationFrame(frame);
}

function render(d0, d1, frac) {
  uf.set(S.vp, 0);
  uf[16] = S.cssW * S.dpr; uf[17] = S.cssH * S.dpr;
  uu[18] = d0; uu[19] = d1;
  uf[20] = frac;
  // Points grow a little as you zoom in.
  uf[21] = 2.2 * S.dpr * clamp(Math.sqrt(40 / S.cam.dist), 0.75, 3.2);
  ui[22] = S.sel; ui[23] = S.hov;
  uf[24] = S.glow * clamp(Math.sqrt(S.cam.dist / 40), 0.55, 1.2);
  uf[25] = S.showGates ? clamp(1.6 - S.cam.dist / 200, 0.5, 1.4) : 0;
  uf[26] = tLo(); uf[27] = tHi();
  device.queue.writeBuffer(uniformBuf, 0, ub);

  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store',
      clearValue: { r: 0.016, g: 0.02, b: 0.04, a: 1 } }],
  });
  pass.setBindGroup(0, S.act.bind);
  if (S.showGates && edgeCount) { pass.setPipeline(linePipe); pass.draw(edgeCount); }
  pass.setPipeline(ptsPipe);
  pass.draw(6, S.N);
  pass.end();
  device.queue.submit([enc.finish()]);
}

// ---------------------------------------------------------------- UI wiring
function initUi() {
  const m = S.meta;
  const act = $('activity');
  act.innerHTML = m.activities.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  act.addEventListener('change', () => loadActivity(+act.value).catch(fatal));

  const names = new Map();
  m.regions.forEach((r, i) => names.set(r.toLowerCase(), { region: i }));
  m.systems.name.forEach((s, i) => { if (!names.has(s.toLowerCase())) names.set(s.toLowerCase(), { system: i }); });
  const opts = [...m.regions.map((r) => `<option value="${esc(r)}">Region</option>`),
    ...[...m.systems.name].sort().map((s) => `<option value="${esc(s)}"></option>`)];
  $('places').innerHTML = opts.join('');
  $('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('search').value.trim().toLowerCase();
    let hit = names.get(q);
    if (!hit && q) {
      const k = [...names.keys()].find((n) => n.startsWith(q));
      hit = k && names.get(k);
    }
    if (!hit) { $('search').setCustomValidity('No region or system by that name'); $('search').reportValidity(); return; }
    $('search').setCustomValidity('');
    if ('region' in hit) { selectSystem(-1); focusRegion(hit.region); } else focusSystem(hit.system);
    $('search').blur();
  });
  $('search').addEventListener('input', () => $('search').setCustomValidity(''));

  $('gates').addEventListener('change', (e) => { S.showGates = e.target.checked; S.dirty = true; });
  $('showLabels').addEventListener('change', (e) => { S.showLabels = e.target.checked; S.dirty = true; });
  $('loop').addEventListener('change', (e) => { S.loop = e.target.checked; });
  $('glow').addEventListener('input', (e) => { S.glow = +e.target.value; S.dirty = true; });
  $('reset').addEventListener('click', () => resetView(true));
  $('play').addEventListener('click', () => togglePlay());
  $('infoClose').addEventListener('click', () => selectSystem(-1));
  $('top').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) focusSystem(+li.dataset.i);
  });

  const tl = $('timeline');
  tl.max = S.D - 1;
  tl.addEventListener('input', () => { setDay(+tl.value); });
  const sp = $('speed');
  sp.addEventListener('input', () => { S.speed = speedFromSlider(+sp.value); setSpeedLabel(); });
  S.speed = speedFromSlider(+sp.value);
  setSpeedLabel();

  // Legend: gradient plus a few round-number ticks.
  const stops = Array.from({ length: 21 }, (_, k) => `${rampCss(k / 20)} ${k * 5}%`);
  $('legendBar').style.background = `linear-gradient(to right, ${stops.join(',')})`;
  const ticks = [0.0005, 0.002, 0.01, 0.05, 0.2];
  $('legendTicks').innerHTML = ticks.map((v, k) => {
    const shift = k === 0 ? '0' : k === ticks.length - 1 ? '-100%' : '-50%';
    return `<span style="left:${valueToT(v) * 100}%;transform:translateX(${shift})">${fmtPct(v).replace('.0%', '%')}</span>`;
  }).join('');
}

function fatal(err) {
  console.error(err);
  setStatus(err.message || String(err), true);
}

// ---------------------------------------------------------------- boot
async function main() {
  const meta = JSON.parse(new TextDecoder().decode(await loadBin('data/meta.bin', 'map')));
  S.meta = meta;
  S.N = meta.systems.id.length;
  S.D = meta.days;
  S.start = Date.parse(`${meta.start}T00:00:00Z`);
  S.missing = new Set(meta.missing);
  S.pos = new Float32Array(meta.systems.pos);
  S.regionOf = Int32Array.from(meta.systems.region);
  S.regionNames = meta.regions;
  LN_MIN = Math.log(meta.vmin);
  LN_SPAN = Math.log(meta.vmax) - LN_MIN;

  const sums = meta.regions.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < S.N; i++) {
    const s = sums[S.regionOf[i]];
    s[0] += S.pos[i * 3]; s[1] += S.pos[i * 3 + 1]; s[2] += S.pos[i * 3 + 2]; s[3]++;
  }
  S.regionCenters = sums.map((s) => [s[0] / s[3], s[1] / s[3], s[2] / s[3]]);

  await initGpu();
  initUi();
  initInput();
  resetView(false);
  await loadActivity(1);
  requestAnimationFrame(frame);
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) togglePlay(true);
}

main().catch(fatal);
