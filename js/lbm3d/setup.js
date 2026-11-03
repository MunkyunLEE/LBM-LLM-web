import { worldVerts, bbox, voxelize, isClosed, decodeMesh } from './mesh.js';
import { generate } from './shapes.js';

export const EX = [0, 1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0];
export const EY = [0, 0, 0, 1, -1, 0, 0, 1, -1, -1, 1, 0, 0, 0, 0, 1, -1, 1, -1];
export const EZ = [0, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, 1, -1, -1, 1, 1, -1, -1, 1];
export const W = [1 / 3, ...Array(6).fill(1 / 18), ...Array(12).fill(1 / 36)];
export const OPP = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15, 18, 17];
export const FACES = ['xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax'];
export const BC = { wall: 0, slip: 1, velocity: 2, pressure: 3, outflow: 4 };
export const MODE = { off: 0, free: 1, hinge: 2, drive: 3 };
export const F_SCALE = 1048576, M_SCALE = 262144;
export const CPU_MAX = 1000000, GPU_MAX = 8000000;
export const MAX_BODIES = 8, MAX_PATCHES = 60, MAX_OBJECTS = 64;
const PRESET = { I: { low: 0.5, mid: 2, high: 8 }, K: { soft: 0.2, mid: 1, stiff: 5 }, C: { low: 0.05, mid: 0.3, high: 1.5 } };

export const REFL = [0, 1, 2].map((a) => EX.map((_, i) => {
  const e = [EX[i], EY[i], EZ[i]];
  e[a] = -e[a];
  return EX.findIndex((_, j) => EX[j] === e[0] && EY[j] === e[1] && EZ[j] === e[2]);
}));

export function meshOf(obj) {
  if (!obj._mesh) obj._mesh = obj.mesh.gen ? generate(obj.mesh.gen) : decodeMesh(obj.mesh);
  return obj._mesh;
}

export function objectVerts(obj) {
  return worldVerts({ ...obj, mesh: meshOf(obj) });
}

export function gridDims3(c) {
  const Lx = +c.Lx, Nx = Math.max(4, Math.trunc(+c.Nx)), dxmm = Lx / Nx;
  const Ny = Math.max(4, Math.round(+c.Ly / dxmm)), Nz = Math.max(4, Math.round(+c.Lz / dxmm));
  return { Lx, Ly: Ny * dxmm, Lz: Nz * dxmm, Nx, Ny, Nz, dxmm, cells: Nx * Ny * Nz };
}

function isKin(o) {
  return o.kin && o.kin.mode && o.kin.mode !== 'off';
}

function axisOf(o) {
  const a = o.kin.axis || [1, 0, 0], L = Math.hypot(...a) || 1;
  return a.map((x) => x / L);
}

function tipRadius(obj) {
  const v = objectVerts(obj), p = obj.kin.pivot || [0, 0, 0], a = axisOf(obj);
  let r = 0;
  for (let i = 0; i < v.length; i += 3) {
    const d = [v[i] - p[0], v[i + 1] - p[1], v[i + 2] - p[2]], s = d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
    r = Math.max(r, Math.hypot(d[0] - s * a[0], d[1] - s * a[1], d[2] - s * a[2]));
  }
  return r;
}

function faceSpeed(b) {
  return b.type === 'velocity' ? Math.hypot(+b.ux || 0, +b.uy || 0, +b.uz || 0) : 0;
}

export function latticeParams3(c, backend = 'cpu') {
  const g = gridDims3(c), nu = +c.fluid.nu, uLat = +(c.u_lat_max ?? 0.06), les = c.les?.enabled ?? true;
  const speeds = FACES.map((k) => faceSpeed(c.faces[k] || {}));
  for (const p of c.patches || []) if (p.type === 'velocity') speeds.push(Math.abs(+p.un || 0));
  for (const o of c.objects || []) {
    if (o.role === 'inlet' && o.inlet) speeds.push(Math.hypot(+o.inlet.ux || 0, +o.inlet.uy || 0, +o.inlet.uz || 0));
    if (isKin(o) && o.kin.mode === 'drive') speeds.push(Math.abs(+o.kin.rpm || 0) * Math.PI / 30 * tipRadius(o) / 1000);
  }
  const hasFlow = speeds.some((s) => s > 1e-9);
  let uMax = Math.max(...speeds, 1e-9);
  if (uMax < 1e-6) uMax = 1;
  const dx = g.dxmm / 1000, dt = uLat * dx / uMax, nuLat = nu * dt / dx ** 2, tau0 = 3 * nuLat + 0.5;
  const steps = Math.ceil(+(c.duration ?? 5) / dt), cap = backend === 'gpu' ? GPU_MAX : CPU_MAX, warnings = [];
  if (g.cells > cap) warnings.push(`셀 수 ${g.cells.toLocaleString()}개가 ${backend === 'gpu' ? 'GPU' : 'CPU'} 상한(${cap.toLocaleString()})을 넘습니다. 분할 수를 줄여 주세요.`);
  if (tau0 < 0.51 && !les) warnings.push(`τ0 = ${tau0.toFixed(5)} (< 0.51): LES를 켜거나 점성/격자를 조정하세요.`);
  if (tau0 < 0.5005 && les) warnings.push('고 Re 조건입니다. LES(Smagorinsky)로 안정화하지만 벽 근처 정확도는 제한적입니다.');
  if (!hasFlow) warnings.push('속도 경계가 없습니다. Δt는 기준 속도 1 m/s로 계산됩니다.');
  return { ...g, dx, dt, nu_lat: nuLat, tau0, u_max: uMax, u_lat: uLat, Re_L: uMax * g.Lx / 1000 / nu, steps, warnings, cap };
}

function rampSteps(c, prm) {
  return Math.max(1, Math.round(+(c.ramp ?? 1) / prm.dt));
}

function rhoOf(p, c, prm) {
  const rho = +(c.fluid.rho ?? 1.2), U = prm.dx / prm.dt;
  return 1 + 3 * (+p || 0) / (rho * U * U);
}

function latVel(b, prm) {
  const s = prm.dt / prm.dx;
  return [(+b.ux || 0) * s, (+b.uy || 0) * s, (+b.uz || 0) * s];
}

function inPatch(p, u, v) {
  const cu = +p.cu || 0, cv = +p.cv || 0;
  if (p.shape === 'circle') return (u - cu) ** 2 + (v - cv) ** 2 <= (+p.r || 0) ** 2;
  if (p.shape === 'poly') {
    const pts = p.pts || [];
    let inside = false;
    for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
      const [xa, ya] = pts[a], [xb, yb] = pts[b];
      if ((ya > v) !== (yb > v) && u < xa + (v - ya) * (xb - xa) / (yb - ya)) inside = !inside;
    }
    return inside;
  }
  return Math.abs(u - cu) <= (+p.a || 0) / 2 && Math.abs(v - cv) <= (+p.b || 0) / 2;
}

export function faceAxes(face) {
  const ax = Math.floor(FACES.indexOf(face) / 2);
  return { n: ax, u: ax === 0 ? 1 : 0, v: ax === 2 ? 1 : 2, side: FACES.indexOf(face) % 2 };
}

export function buildSetup(c, backend = 'cpu') {
  const prm = latticeParams3(c, backend), { Nx, Ny, Nz, dxmm } = prm, N = Nx * Ny * Nz, NxNy = Nx * Ny;
  const base = new Uint32Array(N).fill(255 << 2), objects = c.objects || [];
  if (objects.length > MAX_OBJECTS) throw new Error(`객체는 최대 ${MAX_OBJECTS}개입니다.`);
  const bcf = new Float32Array(8 * (6 + MAX_PATCHES)), info = [], bodies = [], refs = new Float32Array(4 * MAX_OBJECTS);
  const spongeW = Math.max(0, +(c.sponge ?? 6)) / 100, Ns = [Nx, Ny, Nz];
  FACES.forEach((k, fi) => {
    const b = c.faces[k] || { type: 'wall' }, t = BC[b.type] ?? 0, u = latVel(b, prm);
    const w = t >= 2 && spongeW > 0 ? Math.max(3, Math.round(spongeW * Ns[Math.floor(fi / 2)])) : 0;
    bcf.set([t, t === 3 ? rhoOf(b.p, c, prm) : 1, w, fi, u[0], u[1], u[2], 0], fi * 8);
  });
  const patches = (c.patches || []).slice(0, MAX_PATCHES);
  let np = 0;
  const pemit = [];
  const addPatch = (face, type, rho, u) => { if (np >= MAX_PATCHES) throw new Error(`유입/유출 구간은 최대 ${MAX_PATCHES}개입니다.`);
    const id = np++; pemit.push(type === 2); bcf.set([type, rho, 0, face, u[0], u[1], u[2], 0], (6 + id) * 8); return id + 1; };
  patches.forEach((p) => {
    const fa = faceAxes(p.face), fi = FACES.indexOf(p.face);
    if (fi < 0) return;
    const t = p.type === 'pressure' ? 3 : p.type === 'outflow' ? 4 : 2, sgn = fa.side === 0 ? 1 : -1, s = prm.dt / prm.dx;
    const u = [0, 0, 0];
    if (t === 2) u[fa.n] = sgn * (+p.un || 0) * s;
    const id = addPatch(fi, t, t === 3 ? rhoOf(p.p, c, prm) : 1, u), nu = Ns[fa.u], nv = Ns[fa.v], layer = fa.side === 0 ? 0 : Ns[fa.n] - 1;
    for (let jv = 0; jv < nv; jv++) for (let iu = 0; iu < nu; iu++) {
      if (!inPatch(p, (iu + 0.5) * dxmm, (jv + 0.5) * dxmm)) continue;
      const q = [0, 0, 0]; q[fa.n] = layer; q[fa.u] = iu; q[fa.v] = jv;
      const k = q[0] + Nx * q[1] + NxNy * q[2];
      base[k] = (base[k] & ~(255 << 10)) | (id << 10);
    }
  });
  const grid = { o: [0, 0, 0], h: 1, n: [Nx, Ny, Nz] };
  objects.forEach((o, oi) => {
    const vmm = objectVerts(o), v = vmm.map((x) => x / dxmm), m = meshOf(o), [lo, hi] = bbox(vmm);
    const ref = isKin(o) ? (o.kin.pivot || [0, 0, 0]) : [0, 1, 2].map((d) => (lo[d] + hi[d]) / 2);
    refs.set([ref[0] / dxmm, ref[1] / dxmm, ref[2] / dxmm, 0], oi * 4);
    const mode = o.voxel && o.voxel !== 'auto' ? o.voxel : (isClosed(m) ? 'solid' : 'shell'), band = 0.9;
    const role = o.role || 'solid';
    info.push({ name: o.name || `obj${oi + 1}`, role, kin: isKin(o) ? o.kin.mode : 'off', bbox: [lo, hi], ref, cells: 0 });
    if (role !== 'solid') {
      const id = role === 'inlet' ? addPatch(6, 2, 1, latVel(o.inlet || {}, prm)) : addPatch(6, 3, rhoOf(o.outlet?.p, c, prm), [0, 0, 0]);
      voxelize(v, m.f, grid, mode === 'shell' ? 'both' : mode, band, (i, j, k) => {
        const q = i + Nx * j + NxNy * k;
        if ((base[q] & 3) === 0) base[q] = (base[q] & ~(255 << 10)) | (id << 10);
      });
      return;
    }
    if (!isKin(o)) {
      let n = 0;
      voxelize(v, m.f, grid, mode, band, (i, j, k) => { const q = i + Nx * j + NxNy * k; if ((base[q] & 3) === 0) n++; base[q] = 1 | (oi << 2) | (base[q] & (255 << 10)); });
      info[oi].cells = n;
      return;
    }
    if (bodies.length >= MAX_BODIES) throw new Error(`움직이는 객체는 최대 ${MAX_BODIES}개입니다.`);
    bodies.push(makeBody(o, oi, v, m.f, mode, band, prm, c));
  });
  return { prm, N, base, bcf, npatch: np, refs, info, bodies, nobj: objects.length, rampSteps: rampSteps(c, prm), alpha: 1 / (14 * Math.max(Nx, Ny, Nz)), cs2: (c.les?.enabled ?? true) ? (+(c.les?.cs ?? 0.15)) ** 2 : 0, emitters: emitters(c, prm, base, pemit) };
}

function makeBody(o, oi, v, f, mode, band, prm, c) {
  const dxmm = prm.dxmm, h = 0.5, [lo, hi] = bbox(v), pad = band + 1;
  const org = lo.map((x) => x - pad), dims = [0, 1, 2].map((d) => Math.ceil((hi[d] - lo[d] + 2 * pad) / h));
  const nb = dims[0] * dims[1] * dims[2], bits = new Uint32Array(Math.ceil(nb / 32));
  voxelize(v, f, { o: org, h, n: dims }, mode, band, (i, j, k) => { const q = i + dims[0] * (j + dims[1] * k); bits[q >> 5] |= 1 << (q & 31); });
  const p = (o.kin.pivot || [0, 0, 0]).map((x) => x / dxmm), a = axisOf(o);
  let rb = 0, rt = 0, s0 = Infinity, s1 = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    const d = [v[i] - p[0], v[i + 1] - p[1], v[i + 2] - p[2]], s = d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
    rb = Math.max(rb, Math.hypot(...d)); rt = Math.max(rt, Math.hypot(d[0] - s * a[0], d[1] - s * a[1], d[2] - s * a[2]));
    s0 = Math.min(s0, s); s1 = Math.max(s1, s);
  }
  rb += band + 1;
  const R = Math.max(rt, 1), U = prm.u_lat, k = o.kin, adv = k.advanced || {}, sc = prm.dx ** 5 * +(c.fluid.rho ?? 1.2);
  let I = (PRESET.I[k.inertia] ?? 2) * R ** 5, K = k.mode === 'hinge' ? (PRESET.K[k.spring] ?? 1) * U * U * R ** 3 : 0, C = (PRESET.C[k.damping] ?? 0.3) * U * R ** 4;
  if (adv.enabled) {
    if (+adv.I > 0) I = +adv.I / sc;
    if (adv.c !== undefined && adv.c !== '') C = Math.max(0, +adv.c) / (sc / prm.dt);
    if (k.mode === 'hinge' && adv.k !== undefined && adv.k !== '') K = Math.max(0, +adv.k) / (sc / prm.dt ** 2);
  }
  const lim = k.mode === 'hinge' ? [+(adv.enabled ? adv.min : undefined) || -90, +(adv.enabled ? adv.max : undefined) || 90] : [-1e9, 1e9];
  const wd = k.mode === 'drive' ? (+k.rpm || 0) * Math.PI / 30 * (k.dir === 'cw' ? -1 : 1) * prm.dt : 0;
  const Ia = 0.25 * Math.max(1, s1 - s0) * Math.max(rt, 1) ** 4;
  return { owner: oi, mode: MODE[k.mode] ?? 0, pivot: p, axis: a, I, K, C, Ia, thmin: lim[0] * Math.PI / 180, thmax: lim[1] * Math.PI / 180, wd, rb, rt: R, h, org, dims, bits, wmax: 0.12 / R };
}

function emitters(c, prm, base, pemit) {
  const { Nx, Ny, Nz } = prm, out = [], NxNy = Nx * Ny;
  FACES.forEach((k, fi) => {
    const b = c.faces[k] || {};
    if (b.type !== 'velocity') return;
    const a = Math.floor(fi / 2), u = [b.ux || 0, b.uy || 0, b.uz || 0][a] * (fi % 2 ? -1 : 1);
    if (u <= 0) return;
    const fa = faceAxes(k), Ns = [Nx, Ny, Nz], step = Math.max(1, Math.round(Math.max(Ns[fa.u], Ns[fa.v]) / 24));
    for (let jv = step / 2; jv < Ns[fa.v]; jv += step) for (let iu = step / 2; iu < Ns[fa.u]; iu += step) {
      const q = [0, 0, 0]; q[fa.n] = fi % 2 ? Ns[a] - 1.5 : 1.5; q[fa.u] = iu; q[fa.v] = jv;
      out.push(q[0], q[1], q[2], step * 0.5);
    }
  });
  const lists = new Map();
  for (let k = 0; k < base.length; k++) {
    const pid = (base[k] >> 10) & 255;
    if (!pid || (base[k] & 3)) continue;
    if (!lists.has(pid)) lists.set(pid, []);
    lists.get(pid).push(k);
  }
  for (const [pid, ks] of lists) {
    if (!pemit[pid - 1]) continue;
    const stride = Math.max(1, Math.floor(ks.length / 300));
    for (let q = 0; q < ks.length; q += stride) {
      const k = ks[q], x = k % Nx, y = Math.floor(k / Nx) % Ny, z = Math.floor(k / NxNy);
      out.push(x + 0.5, y + 0.5, z + 0.5, 0.5);
    }
  }
  if (!out.length) for (let n = 0; n < 400; n++) out.push(Math.random() * Nx, Math.random() * Ny, Math.random() * Nz, 0.5);
  return new Float32Array(out);
}

export function bodyBuffer(bodies) {
  const B = new Float32Array(32 * MAX_BODIES);
  let off = 0;
  const words = [];
  bodies.forEach((b, i) => {
    B.set([b.pivot[0], b.pivot[1], b.pivot[2], b.mode, b.axis[0], b.axis[1], b.axis[2], b.owner, 0, 0, b.I, b.K, b.C, b.thmin, b.thmax, b.wd,
      b.rb, b.rt, b.h, off, b.org[0], b.org[1], b.org[2], b.wmax, b.dims[0], b.dims[1], b.dims[2], b.Ia, 0, 0, 0, 0], i * 32);
    words.push(b.bits); off += b.bits.length;
  });
  const occ = new Uint32Array(Math.max(1, off));
  let o = 0;
  for (const w of words) { occ.set(w, o); o += w.length; }
  return { B, occ };
}
