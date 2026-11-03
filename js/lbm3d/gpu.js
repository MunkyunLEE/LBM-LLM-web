import { EX, EY, EZ, W, OPP, REFL, F_SCALE, M_SCALE, MAX_PATCHES, MAX_BODIES, MAX_OBJECTS, bodyBuffer } from './setup.js';
import { initParts } from './particles3d.js';

const BCN = 8 * (6 + MAX_PATCHES), BODY = BCN, REFS = BODY + 32 * MAX_BODIES, GLOB = REFS + 4 * MAX_OBJECTS, LOADS = GLOB + 8, MISC = LOADS + 6 * MAX_OBJECTS;
const arr = (t, a) => `array<${t},19>(${a.map((v) => (t === 'f32' ? `${v}` : `${v}${t === 'u32' ? 'u' : ''}`)).join(',')})`;

const COMMON = /* wgsl */`
struct P { N: u32, Nx: u32, Ny: u32, Nz: u32, tau0: f32, cs2: f32, nbody: u32, nobj: u32, rampSteps: f32, wgx: u32, alpha: f32, a1: u32 };
@group(0) @binding(0) var<uniform> p: P;
var<private> EX: array<i32,19> = ${arr('i32', EX)};
var<private> EY: array<i32,19> = ${arr('i32', EY)};
var<private> EZ: array<i32,19> = ${arr('i32', EZ)};
var<private> W: array<f32,19> = ${arr('f32', W.map((w) => w.toPrecision(9)))};
var<private> OPP: array<u32,19> = ${arr('u32', OPP)};
const BODY: u32 = ${BODY}u; const REFS: u32 = ${REFS}u; const GLOB: u32 = ${GLOB}u; const LOADS: u32 = ${LOADS}u;
fn cellIndex(g: vec3<u32>) -> u32 { return g.x + g.y * p.wgx; }
`;

const STREAM = COMMON + /* wgsl */`
@group(0) @binding(1) var<storage, read> fa: array<f32>;
@group(0) @binding(2) var<storage, read_write> fb: array<f32>;
@group(0) @binding(3) var<storage, read> cell: array<u32>;
@group(0) @binding(4) var<storage, read_write> mac: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> misc: array<f32>;
@group(0) @binding(6) var<storage, read_write> acc: array<atomic<i32>>;
@group(0) @binding(13) var<storage, read_write> rbar: array<f32>;
var<private> R0: array<u32,19> = ${arr('u32', REFL[0])};
var<private> R1: array<u32,19> = ${arr('u32', REFL[1])};
var<private> R2: array<u32,19> = ${arr('u32', REFL[2])};

fn bodyOf(own: u32) -> u32 {
  for (var b = 0u; b < p.nbody; b++) { if (u32(misc[BODY + b * 32u + 7u]) == own) { return b; } }
  return 0u;
}
fn wallVel(b: u32, X: vec3<f32>) -> vec3<f32> {
  let o = BODY + b * 32u;
  let a = vec3<f32>(misc[o + 4u], misc[o + 5u], misc[o + 6u]) * misc[o + 9u];
  return cross(a, X - vec3<f32>(misc[o], misc[o + 1u], misc[o + 2u]));
}
fn flush(own: u32, F: vec3<f32>, M: vec3<f32>) {
  let q = own * 6u;
  atomicAdd(&acc[q], i32(round(F.x * ${F_SCALE}.0))); atomicAdd(&acc[q + 1u], i32(round(F.y * ${F_SCALE}.0))); atomicAdd(&acc[q + 2u], i32(round(F.z * ${F_SCALE}.0)));
  atomicAdd(&acc[q + 3u], i32(round(M.x * ${M_SCALE}.0))); atomicAdd(&acc[q + 4u], i32(round(M.y * ${M_SCALE}.0))); atomicAdd(&acc[q + 5u], i32(round(M.z * ${M_SCALE}.0)));
}
fn spongeAt(x: i32, y: i32, z: i32) -> f32 {
  var s = 0.0;
  var c = array<i32,3>(x, y, z); var n = array<i32,3>(i32(p.Nx), i32(p.Ny), i32(p.Nz));
  for (var fc = 0u; fc < 6u; fc++) {
    let w = misc[fc * 8u + 2u];
    if (w <= 0.0) { continue; }
    let a = fc / 2u;
    var d = c[a];
    if ((fc & 1u) == 1u) { d = n[a] - 1 - c[a]; }
    if (f32(d) < w) { let t = 1.0 - f32(d) / max(w - 1.0, 1.0); s = max(s, 0.08 * t * t); }
  }
  return s;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let k = cellIndex(g);
  if (k >= p.N) { return; }
  let Nx = i32(p.Nx); let Ny = i32(p.Ny); let Nz = i32(p.Nz); let N = p.N;
  let x = i32(k % p.Nx); let y = i32((k / p.Nx) % p.Ny); let z = i32(k / (p.Nx * p.Ny));
  let c = cell[k];
  if ((c & 3u) != 0u) { mac[k] = vec4<f32>(0.0); return; }
  let pid = (c >> 10u) & 255u;
  let ramp = misc[GLOB + 1u];
  var f: array<f32,19>;
  var cown = -1; var F = vec3<f32>(0.0); var M = vec3<f32>(0.0);
  for (var i = 0u; i < 19u; i++) {
    let sx = x - EX[i]; let sy = y - EY[i]; let sz = z - EZ[i];
    let e = vec3<f32>(f32(EX[i]), f32(EY[i]), f32(EZ[i]));
    let o = OPP[i];
    if (sx >= 0 && sx < Nx && sy >= 0 && sy < Ny && sz >= 0 && sz < Nz) {
      let s = u32(sx + Nx * (sy + Ny * sz));
      let cs = cell[s];
      if ((cs & 3u) == 0u) { f[i] = fa[i * N + s]; continue; }
      let fo = fa[o * N + k]; let own = (cs >> 2u) & 255u;
      let X = vec3<f32>(f32(x) + 0.5, f32(y) + 0.5, f32(z) + 0.5) - 0.5 * e;
      var fi = fo;
      if ((cs & 3u) == 2u) { fi += 6.0 * W[i] * dot(e, wallVel(bodyOf(own), X)); }
      f[i] = fi;
      if (own != 255u) {
        if (i32(own) != cown) { if (cown >= 0) { flush(u32(cown), F, M); } cown = i32(own); F = vec3<f32>(0.0); M = vec3<f32>(0.0); }
        let Fl = -(fo + fi) * e;
        let rr = X - vec3<f32>(misc[REFS + own * 4u], misc[REFS + own * 4u + 1u], misc[REFS + own * 4u + 2u]);
        F += Fl; M += cross(rr, Fl);
      }
      continue;
    }
    var fcs = array<i32,3>(-1, -1, -1);
    if (sx < 0) { fcs[0] = 0; } else if (sx >= Nx) { fcs[0] = 1; }
    if (sy < 0) { fcs[1] = 2; } else if (sy >= Ny) { fcs[1] = 3; }
    if (sz < 0) { fcs[2] = 4; } else if (sz >= Nz) { fcs[2] = 5; }
    var ent = -1; var nf = 0; var wallish = false;
    for (var a = 0; a < 3; a++) {
      let fc = fcs[a];
      if (fc < 0) { continue; }
      var en = u32(fc);
      if (pid != 0u && i32(misc[(5u + pid) * 8u + 3u]) == fc) { en = 5u + pid; }
      if (misc[en * 8u] < 1.5) { wallish = true; }
      if (ent < 0) { ent = i32(en); }
      nf++;
    }
    let eb = u32(ent) * 8u;
    var t = u32(misc[eb] + 0.5);
    if (nf > 1 && wallish) { t = 0u; }
    if (t == 0u) { f[i] = fa[o * N + k]; }
    else if (t == 2u) {
      let ub = vec3<f32>(misc[eb + 4u], misc[eb + 5u], misc[eb + 6u]) * ramp;
      f[i] = fa[o * N + k] + 6.0 * W[i] * dot(e, ub);
    } else if (t == 3u) {
      let u = mac[k].xyz; let eu = dot(e, u);
      f[i] = -fa[o * N + k] + 2.0 * W[i] * misc[eb + 1u] * (1.0 + 4.5 * eu * eu - 1.5 * dot(u, u));
    } else {
      var tx = sx; var ty = sy; var tz = sz;
      if (fcs[0] >= 0) { tx = x; } if (fcs[1] >= 0) { ty = y; } if (fcs[2] >= 0) { tz = z; }
      let ts = u32(tx + Nx * (ty + Ny * tz));
      let ok = (cell[ts] & 3u) == 0u;
      if (t == 1u) {
        var ri = R2[i];
        if (fcs[0] >= 0) { ri = R0[i]; } else if (fcs[1] >= 0) { ri = R1[i]; }
        if (ok) { f[i] = fa[ri * N + ts]; } else { f[i] = fa[o * N + k]; }
      } else {
        if (ok) { f[i] = fa[i * N + ts]; } else { f[i] = fa[i * N + k]; }
      }
    }
  }
  if (cown >= 0) { flush(u32(cown), F, M); }
  var r = 0.0; var j = vec3<f32>(0.0);
  for (var i = 0u; i < 19u; i++) { r += f[i]; j += f[i] * vec3<f32>(f32(EX[i]), f32(EY[i]), f32(EZ[i])); }
  let u = j / r; let usq = 1.5 * dot(u, u);
  var pxx = 0.0; var pyy = 0.0; var pzz = 0.0; var pxy = 0.0; var pxz = 0.0; var pyz = 0.0;
  var fq: array<f32,19>;
  for (var i = 0u; i < 19u; i++) {
    let e = vec3<f32>(f32(EX[i]), f32(EY[i]), f32(EZ[i]));
    let eu = dot(e, u); let q = W[i] * r * (1.0 + 3.0 * eu + 4.5 * eu * eu - usq); let d = f[i] - q;
    fq[i] = q;
    pxx += d * e.x * e.x; pyy += d * e.y * e.y; pzz += d * e.z * e.z; pxy += d * e.x * e.y; pxz += d * e.x * e.z; pyz += d * e.y * e.z;
  }
  var tau = p.tau0;
  if (p.cs2 > 0.0) { tau = 0.5 * (p.tau0 + sqrt(p.tau0 * p.tau0 + ${18 * Math.SQRT2} * p.cs2 * sqrt(pxx * pxx + pyy * pyy + pzz * pzz + 2.0 * (pxy * pxy + pxz * pxz + pyz * pyz)) / r)); }
  let aa = 4.5 * (1.0 - 1.0 / tau); let tr = (pxx + pyy + pzz) / 3.0;
  var rt = r; var v = u; var rep = false;
  if (pid != 0u && misc[(5u + pid) * 8u + 3u] > 5.5) {
    rep = true;
    let eb = (5u + pid) * 8u;
    if (misc[eb] < 2.5) { rt = 1.0; v = vec3<f32>(misc[eb + 4u], misc[eb + 5u], misc[eb + 6u]) * ramp; } else { rt = misc[eb + 1u]; }
  }
  var sg = 0.0;
  let sp = spongeAt(x, y, z);
  if (sp > 0.0) { let rb = rbar[k] + p.alpha * (r - rbar[k]); rbar[k] = rb; sg = sp * (rb - r); }
  let vsq = 1.5 * dot(v, v);
  for (var i = 0u; i < 19u; i++) {
    let e = vec3<f32>(f32(EX[i]), f32(EY[i]), f32(EZ[i]));
    let ne = W[i] * aa * (e.x * e.x * pxx + e.y * e.y * pyy + e.z * e.z * pzz + 2.0 * (e.x * e.y * pxy + e.x * e.z * pxz + e.y * e.z * pyz) - tr);
    var eq = fq[i];
    if (rep) { let ev = dot(e, v); eq = W[i] * rt * (1.0 + 3.0 * ev + 4.5 * ev * ev - vsq); }
    var val = eq + ne;
    if (sg != 0.0) { let eu = dot(e, u); val += sg * W[i] * (1.0 + 3.0 * eu + 4.5 * eu * eu - usq); }
    fb[i * N + k] = val;
  }
  mac[k] = vec4<f32>(u, r);
}
`;

const BODYK = COMMON + /* wgsl */`
@group(0) @binding(5) var<storage, read_write> misc: array<f32>;
@group(0) @binding(6) var<storage, read_write> acc: array<atomic<i32>>;
@compute @workgroup_size(1)
fn main() {
  let ramp = misc[GLOB + 1u];
  for (var b = 0u; b < p.nbody; b++) {
    let o = BODY + b * 32u; let mode = u32(misc[o + 3u] + 0.5); let q = u32(misc[o + 7u]) * 6u;
    let Mv = vec3<f32>(f32(atomicLoad(&acc[q + 3u])), f32(atomicLoad(&acc[q + 4u])), f32(atomicLoad(&acc[q + 5u]))) / ${M_SCALE}.0;
    let T = dot(Mv, vec3<f32>(misc[o + 4u], misc[o + 5u], misc[o + 6u]));
    var th = misc[o + 8u]; var w = misc[o + 9u];
    if (mode == 3u) { w = misc[o + 15u] * ramp; }
    else {
      let Ia = misc[o + 27u]; let I = misc[o + 10u] + Ia; let K = misc[o + 11u]; let C = misc[o + 12u]; let wm = misc[o + 23u]; let wp = misc[o + 28u];
      misc[o + 28u] = w;
      w = (I * w + T - K * th + Ia * (w - wp)) / (I + C + K);
      w = clamp(w, -wm, wm);
    }
    th += w;
    if (th < misc[o + 13u]) { th = misc[o + 13u]; w = 0.0; }
    if (th > misc[o + 14u]) { th = misc[o + 14u]; w = 0.0; }
    misc[o + 8u] = th; misc[o + 9u] = w;
  }
  for (var q = 0u; q < p.nobj * 6u; q++) {
    var s = ${F_SCALE}.0;
    if (q % 6u >= 3u) { s = ${M_SCALE}.0; }
    misc[LOADS + q] = f32(atomicLoad(&acc[q])) / s;
    atomicStore(&acc[q], 0);
  }
  let st = misc[GLOB] + 1.0;
  misc[GLOB] = st;
  if (st < p.rampSteps) { misc[GLOB + 1u] = 0.5 * (1.0 - cos(3.14159265 * st / p.rampSteps)); } else { misc[GLOB + 1u] = 1.0; }
}
`;

const VOXEL = COMMON + /* wgsl */`
@group(0) @binding(2) var<storage, read_write> fb: array<f32>;
@group(0) @binding(3) var<storage, read_write> cell: array<u32>;
@group(0) @binding(4) var<storage, read_write> mac: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> misc: array<f32>;
@group(0) @binding(7) var<storage, read> base: array<u32>;
@group(0) @binding(8) var<storage, read> occ: array<u32>;
fn inside(b: u32, X: vec3<f32>) -> bool {
  let o = BODY + b * 32u;
  let pv = vec3<f32>(misc[o], misc[o + 1u], misc[o + 2u]); let d = X - pv; let rb = misc[o + 16u];
  if (dot(d, d) > rb * rb) { return false; }
  let a = vec3<f32>(misc[o + 4u], misc[o + 5u], misc[o + 6u]); let th = misc[o + 8u];
  let c = cos(th); let s = -sin(th);
  let L = pv + d * c + cross(a, d) * s + a * dot(a, d) * (1.0 - c);
  let h = misc[o + 18u];
  let ijk = floor((L - vec3<f32>(misc[o + 20u], misc[o + 21u], misc[o + 22u])) / h);
  let n = vec3<f32>(misc[o + 24u], misc[o + 25u], misc[o + 26u]);
  if (any(ijk < vec3<f32>(0.0)) || any(ijk >= n)) { return false; }
  let q = u32(ijk.x) + u32(n.x) * (u32(ijk.y) + u32(n.y) * u32(ijk.z));
  let w = occ[u32(misc[o + 19u]) + (q >> 5u)];
  return ((w >> (q & 31u)) & 1u) == 1u;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let k = cellIndex(g);
  if (k >= p.N) { return; }
  let x = k % p.Nx; let y = (k / p.Nx) % p.Ny; let z = k / (p.Nx * p.Ny);
  let X = vec3<f32>(f32(x) + 0.5, f32(y) + 0.5, f32(z) + 0.5);
  let old = cell[k]; let bs = base[k];
  var nc = bs;
  if ((bs & 3u) == 0u) {
    for (var b = 0u; b < p.nbody; b++) {
      if (inside(b, X)) { nc = 2u | (u32(misc[BODY + b * 32u + 7u]) << 2u) | (bs & (255u << 10u)); break; }
    }
  }
  if (nc == old) { return; }
  cell[k] = nc;
  if ((old & 3u) == 2u && (nc & 3u) == 0u) {
    let own = (old >> 2u) & 255u;
    var bb = 0u;
    for (var b = 0u; b < p.nbody; b++) { if (u32(misc[BODY + b * 32u + 7u]) == own) { bb = b; } }
    let o = BODY + bb * 32u;
    let uw = cross(vec3<f32>(misc[o + 4u], misc[o + 5u], misc[o + 6u]) * misc[o + 9u], X - vec3<f32>(misc[o], misc[o + 1u], misc[o + 2u]));
    let usq = 1.5 * dot(uw, uw);
    for (var i = 0u; i < 19u; i++) {
      let eu = dot(vec3<f32>(f32(EX[i]), f32(EY[i]), f32(EZ[i])), uw);
      fb[i * p.N + k] = W[i] * (1.0 + 3.0 * eu + 4.5 * eu * eu - usq);
    }
    mac[k] = vec4<f32>(uw, 1.0);
  }
}
`;

const AUX = /* wgsl */`
struct P { N: u32, Nx: u32, Ny: u32, Nz: u32, tau0: f32, cs2: f32, nbody: u32, nobj: u32, rampSteps: f32, wgx: u32, alpha: f32, a1: u32 };
struct Q { np: u32, ne: u32, nsub: u32, seed: u32, dt: f32, maxAge: f32, sx: u32, sy: u32, sz: u32, total: u32, b0: u32, b1: u32 };
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(4) var<storage, read> mac: array<vec4<f32>>;
@group(0) @binding(9) var<uniform> q: Q;
@group(0) @binding(10) var<storage, read_write> parts: array<vec4<f32>>;
@group(0) @binding(11) var<storage, read> emit: array<vec4<f32>>;
@group(0) @binding(12) var<storage, read_write> slice: array<vec4<f32>>;
var<private> rng: u32;
fn rnd() -> f32 { rng = rng * 747796405u + 2891336453u; var w = ((rng >> ((rng >> 28u) + 4u)) ^ rng) * 277803737u; w = (w >> 22u) ^ w; return f32(w) / 4294967296.0; }
fn sampleU(pos: vec3<f32>) -> vec4<f32> {
  let qq = pos - 0.5; let i0 = vec3<i32>(floor(qq)); let fr = qq - floor(qq);
  var ws = 0.0; var u = vec3<f32>(0.0);
  for (var c = 0; c < 8; c++) {
    let off = vec3<i32>(c & 1, (c >> 1) & 1, c >> 2); let ii = i0 + off;
    if (any(ii < vec3<i32>(0)) || ii.x >= i32(p.Nx) || ii.y >= i32(p.Ny) || ii.z >= i32(p.Nz)) { continue; }
    let m = mac[u32(ii.x) + p.Nx * (u32(ii.y) + p.Ny * u32(ii.z))];
    if (m.w == 0.0) { continue; }
    let wv = select(1.0 - fr, fr, vec3<bool>(off.x == 1, off.y == 1, off.z == 1));
    let w = wv.x * wv.y * wv.z;
    ws += w; u += w * m.xyz;
  }
  return vec4<f32>(u, ws);
}
@compute @workgroup_size(64)
fn advect(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= q.np) { return; }
  rng = i * 1664525u + q.seed * 22695477u + 1u;
  var P0 = parts[2u * i]; var pos = P0.xyz; var age = P0.w + 1.0;
  var u = vec3<f32>(0.0);
  if (age <= 0.0) { parts[2u * i].w = age; return; }
  var ok = age <= q.maxAge;
  for (var s = 0u; s < q.nsub; s++) {
    if (!ok) { break; }
    let a = sampleU(pos);
    if (a.w < 0.5) { ok = false; break; }
    u = a.xyz;
    let b = sampleU(pos + 0.5 * q.dt * a.xyz);
    if (b.w < 0.5) { ok = false; break; }
    pos += q.dt * b.xyz;
    if (any(pos < vec3<f32>(0.0)) || pos.x >= f32(p.Nx) || pos.y >= f32(p.Ny) || pos.z >= f32(p.Nz)) { ok = false; }
  }
  if (!ok) {
    let e = emit[min(u32(rnd() * f32(q.ne)), q.ne - 1u)];
    pos = e.xyz + (vec3<f32>(rnd(), rnd(), rnd()) * 2.0 - 1.0) * e.w; age = 0.0; u = vec3<f32>(0.0);
  }
  parts[2u * i] = vec4<f32>(pos, age); parts[2u * i + 1u] = vec4<f32>(u, 0.0);
}
@compute @workgroup_size(64)
fn cut(@builtin(global_invocation_id) g: vec3<u32>) {
  let t = g.x + g.y * p.wgx;
  if (t >= q.total) { return; }
  let a = p.Ny * p.Nz; let b = p.Nx * p.Nz;
  var k = 0u;
  if (t < a) { let y = t % p.Ny; let z = t / p.Ny; k = q.sx + p.Nx * (y + p.Ny * z); }
  else if (t < a + b) { let r = t - a; let x = r % p.Nx; let z = r / p.Nx; k = x + p.Nx * (q.sy + p.Ny * z); }
  else { let r = t - a - b; let x = r % p.Nx; let y = r / p.Nx; k = x + p.Nx * (y + p.Ny * q.sz); }
  slice[t] = mac[k];
}
`;

function dims(n) {
  const groups = Math.ceil(n / 64), gx = Math.min(groups, 65535), gy = Math.ceil(groups / gx);
  return [gx, gy, gx * 64];
}

export async function gpuAvailable() {
  try {
    if (typeof navigator === 'undefined' || !navigator.gpu) return null;
    const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!ad) return null;
    const info = ad.info || {};
    return { name: [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ') || 'WebGPU', maxBinding: ad.limits.maxStorageBufferBindingSize, maxBuffer: ad.limits.maxBufferSize };
  } catch (_) { return null; }
}

export class GPUSolver {
  constructor(S) { this.S = S; }

  async init() {
    const S = this.S, { Nx, Ny, Nz } = S.prm, N = S.N;
    Object.assign(this, { Nx, Ny, Nz, N });
    const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!ad) throw new Error('WebGPU 어댑터를 찾지 못했습니다.');
    const need = 19 * N * 4;
    if (need > ad.limits.maxStorageBufferBindingSize || need > ad.limits.maxBufferSize) throw new Error(`GPU 버퍼 한도 초과: 필요 ${(need / 2 ** 20).toFixed(0)} MB, 허용 ${(ad.limits.maxStorageBufferBindingSize / 2 ** 20).toFixed(0)} MB. 분할 수를 줄여 주세요.`);
    const dev = await ad.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: ad.limits.maxStorageBufferBindingSize, maxBufferSize: ad.limits.maxBufferSize, maxStorageBuffersPerShaderStage: Math.min(10, ad.limits.maxStorageBuffersPerShaderStage) } });
    this.dev = dev;
    this.lost = false;
    dev.lost.then(() => { this.lost = true; });
    const SU = GPUBufferUsage.STORAGE, CD = GPUBufferUsage.COPY_DST, CS = GPUBufferUsage.COPY_SRC;
    const mk = (size, usage = SU | CD | CS) => dev.createBuffer({ size: Math.max(16, Math.ceil(size / 16) * 16), usage });
    const rbar = mk(4 * N); dev.queue.writeBuffer(rbar, 0, new Float32Array(N).fill(1));
    const fa = mk(need), fb = mk(need), cell = mk(4 * N), base = mk(4 * N), macro = mk(16 * N), misc = mk(4 * MISC), acc = mk(4 * 6 * MAX_OBJECTS);
    const feq = new Float32Array(N * 19);
    for (let i = 0; i < 19; i++) feq.fill(W[i], i * N, (i + 1) * N);
    dev.queue.writeBuffer(fa, 0, feq); dev.queue.writeBuffer(fb, 0, feq);
    const m0 = new Float32Array(4 * N);
    for (let k = 0; k < N; k++) m0[4 * k + 3] = 1;
    dev.queue.writeBuffer(macro, 0, m0);
    dev.queue.writeBuffer(cell, 0, S.base); dev.queue.writeBuffer(base, 0, S.base);
    const bb = bodyBuffer(S.bodies), mi = new Float32Array(MISC);
    mi.set(S.bcf, 0); mi.set(bb.B, BODY); mi.set(S.refs, REFS);
    dev.queue.writeBuffer(misc, 0, mi);
    const occ = mk(4 * bb.occ.length); dev.queue.writeBuffer(occ, 0, bb.occ);
    const [gx, gy, wgx] = dims(N);
    this.grid = [gx, gy];
    const pu = new ArrayBuffer(48), pv = new DataView(pu);
    [N, Nx, Ny, Nz].forEach((v, i) => pv.setUint32(i * 4, v, true));
    pv.setFloat32(16, S.prm.tau0, true); pv.setFloat32(20, S.cs2, true); pv.setUint32(24, S.bodies.length, true); pv.setUint32(28, S.nobj, true);
    pv.setFloat32(32, S.rampSteps, true); pv.setUint32(36, wgx, true); pv.setFloat32(40, S.alpha, true);
    const ub = dev.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | CD });
    dev.queue.writeBuffer(ub, 0, pu);
    const qb = dev.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | CD });
    Object.assign(this, { fa, fb, cell, base, macro, misc, acc, occ, ub, qb, mk });
    const pipe = async (code, entry = 'main') => {
      const mod = dev.createShaderModule({ code });
      const info = await mod.getCompilationInfo();
      const errs = info.messages.filter((m) => m.type === 'error');
      if (errs.length) throw new Error('WGSL: ' + errs.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; '));
      return dev.createComputePipelineAsync({ layout: 'auto', compute: { module: mod, entryPoint: entry } });
    };
    const [ps, pb, pvx, pad, pcut] = await Promise.all([pipe(STREAM), pipe(BODYK), pipe(VOXEL), pipe(AUX, 'advect'), pipe(AUX, 'cut')]);
    const bg = (pl, ents) => dev.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: Object.entries(ents).map(([b, buffer]) => ({ binding: +b, resource: { buffer } })) });
    this.pl = { ps, pb, pvx, pad, pcut };
    this.bgS = [bg(ps, { 0: ub, 1: fa, 2: fb, 3: cell, 4: macro, 5: misc, 6: acc, 13: rbar }), bg(ps, { 0: ub, 1: fb, 2: fa, 3: cell, 4: macro, 5: misc, 6: acc, 13: rbar })];
    this.bgB = bg(pb, { 0: ub, 5: misc, 6: acc });
    this.bgV = [bg(pvx, { 0: ub, 2: fb, 3: cell, 4: macro, 5: misc, 7: base, 8: occ }), bg(pvx, { 0: ub, 2: fa, 3: cell, 4: macro, 5: misc, 7: base, 8: occ })];
    this.parity = 0;
    this.step = 0;
    this.nbody = S.bodies.length;
    const total = Ny * Nz + Nx * Nz + Nx * Ny;
    this.sliceTotal = total;
    this.sliceBuf = mk(16 * total);
    this.emitBuf = mk(S.emitters.byteLength); dev.queue.writeBuffer(this.emitBuf, 0, S.emitters);
    this.partBuf = null;
    if (this.nbody) {
      const enc = dev.createCommandEncoder(), pass = enc.beginComputePass();
      pass.setPipeline(this.pl.pvx); pass.setBindGroup(0, this.bgV[1]); pass.dispatchWorkgroups(gx, gy); pass.end();
      dev.queue.submit([enc.finish()]);
    }
    await dev.queue.onSubmittedWorkDone();
    return this;
  }

  run(n) {
    const dev = this.dev, enc = dev.createCommandEncoder(), [gx, gy] = this.grid;
    const pass = enc.beginComputePass();
    for (let s = 0; s < n; s++) {
      pass.setPipeline(this.pl.ps); pass.setBindGroup(0, this.bgS[this.parity]); pass.dispatchWorkgroups(gx, gy);
      pass.setPipeline(this.pl.pb); pass.setBindGroup(0, this.bgB); pass.dispatchWorkgroups(1);
      if (this.nbody) { pass.setPipeline(this.pl.pvx); pass.setBindGroup(0, this.bgV[this.parity]); pass.dispatchWorkgroups(gx, gy); }
      this.parity ^= 1;
    }
    pass.end();
    dev.queue.submit([enc.finish()]);
    this.step += n;
  }

  async sync() { await this.dev.queue.onSubmittedWorkDone(); }

  resetParts() { this.partBuf = null; }

  async frame(sl, po) {
    const dev = this.dev, { Nx, Ny, Nz } = this;
    if (po && (!this.partBuf || this.np !== po.count)) {
      this.np = po.count;
      this.partBuf = this.mk(32 * po.count);
      dev.queue.writeBuffer(this.partBuf, 0, initParts(po.count, this.S.emitters, po.maxAge));
      this.bgA = null;
    }
    if (!this.bgC) this.bgC = dev.createBindGroup({ layout: this.pl.pcut.getBindGroupLayout(0), entries: [[0, this.ub], [4, this.macro], [9, this.qb], [12, this.sliceBuf]].map(([b, buffer]) => ({ binding: b, resource: { buffer } })) });
    if (po && !this.bgA) this.bgA = dev.createBindGroup({ layout: this.pl.pad.getBindGroupLayout(0), entries: [[0, this.ub], [4, this.macro], [9, this.qb], [10, this.partBuf], [11, this.emitBuf]].map(([b, buffer]) => ({ binding: b, resource: { buffer } })) });
    const qa = new ArrayBuffer(48), qv = new DataView(qa);
    qv.setUint32(0, po ? po.count : 0, true); qv.setUint32(4, this.S.emitters.length / 4, true); qv.setUint32(8, po ? po.nsub : 0, true);
    qv.setUint32(12, (Math.random() * 1e9) >>> 0, true); qv.setFloat32(16, po ? po.dt : 0, true); qv.setFloat32(20, po ? po.maxAge : 0, true);
    qv.setUint32(24, sl[0], true); qv.setUint32(28, sl[1], true); qv.setUint32(32, sl[2], true); qv.setUint32(36, this.sliceTotal, true);
    dev.queue.writeBuffer(this.qb, 0, qa);
    const enc = dev.createCommandEncoder(), pass = enc.beginComputePass(), [gx, gy] = dims(this.sliceTotal);
    pass.setPipeline(this.pl.pcut); pass.setBindGroup(0, this.bgC); pass.dispatchWorkgroups(gx, gy);
    if (po) { pass.setPipeline(this.pl.pad); pass.setBindGroup(0, this.bgA); pass.dispatchWorkgroups(Math.ceil(po.count / 64)); }
    pass.end();
    const sz = 16 * this.sliceTotal, pz = po ? 32 * po.count : 0, mz = 4 * MISC;
    const rd = dev.createBuffer({ size: sz + pz + mz, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    enc.copyBufferToBuffer(this.sliceBuf, 0, rd, 0, sz);
    if (po) enc.copyBufferToBuffer(this.partBuf, 0, rd, sz, pz);
    enc.copyBufferToBuffer(this.misc, 0, rd, sz + pz, mz);
    dev.queue.submit([enc.finish()]);
    await rd.mapAsync(GPUMapMode.READ);
    const all = new Float32Array(rd.getMappedRange().slice(0));
    rd.unmap(); rd.destroy();
    const a = Ny * Nz, b = Nx * Nz;
    const X = all.slice(0, 4 * a), Y = all.slice(4 * a, 4 * (a + b)), Z = all.slice(4 * (a + b), 4 * this.sliceTotal);
    const parts = po ? all.slice(sz / 4, (sz + pz) / 4) : null, mi = all.subarray((sz + pz) / 4);
    const bodies = [];
    for (let q = 0; q < this.nbody; q++) bodies.push([mi[BODY + q * 32 + 8], mi[BODY + q * 32 + 9]]);
    let div = this.lost;
    for (const arr of [X, Y, Z]) for (let k = 3; k < arr.length; k += 4 * 7) { const r = arr[k]; if (r !== r || r > 3 || (r < 0.2 && r !== 0)) div = true; }
    return { step: Math.round(mi[GLOB]), X, Y, Z, parts, bodies, loads: mi.slice(LOADS, LOADS + 6 * this.S.nobj), diverged: div };
  }

  destroy() {
    try { this.dev.destroy(); } catch (_) {}
  }
}
