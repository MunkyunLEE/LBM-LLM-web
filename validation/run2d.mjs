import fs from 'fs';
import { Solver } from '../js/lbm/solver.js';

const name = process.argv[2];
const out = (o) => fs.writeFileSync(new URL(`./out/${o.id}.json`, import.meta.url), JSON.stringify(o));
const E = (type, ux = 0, uy = 0, p = 0) => ({ type, ux, uy, p });

const GHIA = {
  y: [1, 0.9766, 0.9688, 0.9609, 0.9531, 0.8516, 0.7344, 0.6172, 0.5, 0.4531, 0.2813, 0.1719, 0.1016, 0.0703, 0.0625, 0.0547, 0],
  u100: [1, 0.84123, 0.78871, 0.73722, 0.68717, 0.23151, 0.00332, -0.13641, -0.20581, -0.2109, -0.15662, -0.1015, -0.06434, -0.04775, -0.04192, -0.03717, 0],
  u1000: [1, 0.65928, 0.57492, 0.51117, 0.46604, 0.33304, 0.18719, 0.05702, -0.0608, -0.10648, -0.27805, -0.38289, -0.2973, -0.2222, -0.20196, -0.18109, 0],
  x: [1, 0.9688, 0.9609, 0.9531, 0.9453, 0.9063, 0.8594, 0.8047, 0.5, 0.2344, 0.2266, 0.1563, 0.0938, 0.0781, 0.0703, 0.0625, 0],
  v100: [0, -0.05906, -0.07391, -0.08864, -0.10313, -0.16914, -0.22445, -0.24533, 0.05454, 0.17527, 0.17507, 0.16077, 0.12317, 0.1089, 0.10091, 0.09233, 0],
  v1000: [0, -0.21388, -0.27669, -0.33714, -0.39188, -0.5155, -0.42665, -0.31966, 0.02526, 0.32235, 0.33075, 0.37095, 0.32627, 0.30353, 0.29012, 0.27485, 0],
};

function interp(arr, Nx, Ny, x, y) {
  const fx = x - 0.5, fy = y - 0.5, i = Math.max(0, Math.min(Nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(Ny - 2, Math.floor(fy))), a = fx - i, b = fy - j;
  return (1 - a) * (1 - b) * arr[j * Nx + i] + a * (1 - b) * arr[j * Nx + i + 1] + (1 - a) * b * arr[(j + 1) * Nx + i] + a * b * arr[(j + 1) * Nx + i + 1];
}

function cavity(Re) {
  const N = +(process.env.N || 128), U = 1, L = 1000;
  const c = { Lx: L, Ly: L, Nx: N, fluid: { nu: U * L / 1000 / Re, rho: 1 }, les: { enabled: false }, u_lat_max: 0.1, duration: 1e9, ramp: 0.5, sponge: 0,
    edges: { left: E('wall'), right: E('wall'), bottom: E('wall'), top: E('velocity', U, 0) }, patches: [], obstacles: [] };
  const s = new Solver(c), steps = Re >= 1000 ? 90000 : 30000;
  for (let n = 0; n < steps; n++) { s.step(); if (n % 10000 === 0) process.stdout.write(`cavity ${Re} ${n}\n`); }
  const uL = 0.1, u = [], v = [];
  for (let k = 0; k <= 64; k++) {
    const t = k / 64;
    u.push([t, interp(s.ux, N, N, N / 2, 1 + t * (N - 1.5)) / uL]);
    v.push([t, interp(s.uy, N, N, 1 + t * (N - 2), (1 + N - 0.5) / 2) / uL]);
  }
  let best = Infinity, ps = [0, 0];
  for (let j = 2; j < N - 2; j++) for (let i = 2; i < N - 2; i++) {
    const k = j * N + i, sp = Math.hypot(s.ux[k], s.uy[k]);
    if (sp < best && i > N * 0.3 && i < N * 0.8 && j > N * 0.3 && j < N * 0.85) { best = sp; ps = [(i - 0.5) / (N - 2), (j - 0.5) / (N - 1.5)]; }
  }
  const err = (sim, refx, refv) => { let e = 0, m = 0; refx.forEach((t, q) => { const val = sim[Math.round(t * 64)][1]; e += (val - refv[q]) ** 2; m = Math.max(m, Math.abs(refv[q])); }); return Math.sqrt(e / refx.length) / m; };
  const ref = { u: GHIA[`u${Re}`].map((val, q) => [GHIA.y[q], val]), v: GHIA[`v${Re}`].map((val, q) => [GHIA.x[q], val]), vortex: Re === 100 ? [0.6172, 0.7344] : [0.5313, 0.5625] };
  const st = [];
  const step = 4;
  for (let j = 0; j < N; j += step) for (let i = 0; i < N; i += step) { const k = j * N + i; st.push([+(s.ux[k] / uL).toFixed(4), +(s.uy[k] / uL).toFixed(4)]); }
  out({ id: `2d_cavity_${Re}`, Re, N, steps, u, v, ref, vortex: ps, errU: err(u, GHIA.y, GHIA[`u${Re}`]), errV: err(v, GHIA.x, GHIA[`v${Re}`]), field: { n: N / step, uv: st } });
  console.log('cavity', Re, 'errU', err(u, GHIA.y, GHIA[`u${Re}`]).toFixed(4), 'errV', err(v, GHIA.x, GHIA[`v${Re}`]).toFixed(4), 'vortex', ps);
}

function poiseuille() {
  const H = 500, L = 4000, N = 320, U = 0.1, Re = 20;
  const c = { Lx: L, Ly: H, Nx: N, fluid: { nu: U * H / 1000 / Re, rho: 1 }, les: { enabled: false }, u_lat_max: 0.05, duration: 1e9, ramp: 1, sponge: 0,
    edges: { left: E('velocity', U, 0), right: E('pressure'), bottom: E('wall'), top: E('wall') }, patches: [], obstacles: [] };
  const s = new Solver(c), Ny = s.Ny, steps = 24000;
  for (let n = 0; n < steps; n++) s.step();
  const xs = Math.round(0.7 * N), prof = [];
  const h = Ny - 2;
  let q = 0;
  for (let y = 1; y < Ny - 1; y++) q += s.ux[y * N + xs];
  const ub = q / h;
  for (let y = 1; y < Ny - 1; y++) prof.push([(y - 0.5) / h, s.ux[y * N + xs] / ub]);
  const ana = [];
  for (let i = 0; i <= 100; i++) { const t = i / 100; ana.push([t, 6 * t * (1 - t)]); }
  const sec = (x) => { let r = 0; for (let y = 1; y < Ny - 1; y++) r += s.rho[y * N + x]; return r / h; };
  const x1 = Math.round(0.4 * N), x2 = Math.round(0.9 * N), dpdx = (sec(x2) - sec(x1)) / 3 / (x2 - x1);
  const nuL = s.prm.nu_lat, dpRef = -12 * nuL * ub / (h * h);
  let e = 0; prof.forEach(([t, v]) => { e += (v - 6 * t * (1 - t)) ** 2; });
  out({ id: '2d_poiseuille', Re, grid: [N, Ny], steps, prof, ana, dpdx, dpRef, err: Math.sqrt(e / h) / 1.5 });
  console.log('poiseuille dp/dx', dpdx, 'ref', dpRef, 'profile rms', (Math.sqrt(e / h) / 1.5).toFixed(4));
}

function cylinder() {
  const D = +(process.env.D || 20), dx = 10, Lc = 25 * D, Hc = +(process.env.H || 20) * D, U = 0.1, Re = 100;
  const R = D * dx / 2, cx = 7 * D * dx, cy = Hc * dx / 2 + 0.6 * dx, pts = [];
  for (let k = 0; k < 96; k++) { const t = 2 * Math.PI * k / 96; pts.push([cx + R * Math.cos(t), cy + R * Math.sin(t)]); }
  const c = { Lx: Lc * dx, Ly: Hc * dx, Nx: Lc, fluid: { nu: U * D * dx / 1000 / Re, rho: 1 }, les: { enabled: false }, u_lat_max: 0.05, duration: 1e9, ramp: 2, sponge: 0.08,
    edges: { left: E('velocity', U, 0), right: E('pressure'), bottom: E('slip'), top: E('slip') }, patches: [],
    obstacles: [{ id: 1, curves: [{ closed: true, points: pts }], role: 'solid', ref: [cx, cy] }] };
  const s = new Solver(c), steps = +(process.env.STEPS || 60000), qd = 0.5 * 1 * U * U * D * dx / 1000, hist = [];
  for (let n = 0; n < steps; n++) {
    s.step();
    if (n % 20 === 0) { const L = s.objectLoads()[0]; hist.push([n * s.prm.dt, L.fx / qd, L.fy / qd]); }
    if (n % 10000 === 0) process.stdout.write(`cyl ${n}\n`);
  }
  const tail = hist.slice(Math.floor(hist.length * 0.5));
  const cd = tail.reduce((a, b) => a + b[1], 0) / tail.length, cls = tail.map((h) => h[2]);
  const clAmp = (Math.max(...cls) - Math.min(...cls)) / 2, cm = cls.reduce((a, b) => a + b, 0) / cls.length;
  const cross = [];
  for (let i = 1; i < tail.length; i++) if (tail[i - 1][2] - cm < 0 && tail[i][2] - cm >= 0) cross.push(tail[i][0]);
  const T = (cross.at(-1) - cross[0]) / (cross.length - 1), St = D * dx / 1000 / (U * T);
  const Nx = s.Nx, Ny = s.Ny, w = [];
  for (let j = 0; j < Ny; j += 3) for (let i = 0; i < Nx; i += 3) { const k = j * Nx + i; w.push(s.solid[k] ? null : +(Math.hypot(s.ux[k], s.uy[k]) / 0.05).toFixed(3)); }
  out({ id: '2d_cylinder', Re, D, grid: [Nx, Ny], cd, clAmp, St, ref: { cd: 1.33, clAmp: 0.33, St: 0.165, cdRange: [1.31, 1.35], stRange: [0.164, 0.167] }, hist: hist.filter((_, i) => i % 5 === 0), field: { nx: Math.ceil(Nx / 3), ny: Math.ceil(Ny / 3), umag: w } });
  console.log('cylinder Cd', cd.toFixed(4), 'Cl amp', clAmp.toFixed(4), 'St', St.toFixed(4));
}

if (name === 'cavity') cavity(+process.argv[3]);
else if (name === 'poiseuille') poiseuille();
else if (name === 'cylinder') cylinder();
