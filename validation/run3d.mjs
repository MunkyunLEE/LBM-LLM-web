import fs from 'fs';
import { buildSetup } from '../js/lbm3d/setup.js';
import { CPUSolver } from '../js/lbm3d/cpu.js';

const name = process.argv[2], arg = +(process.argv[3] || 0);
const out = (o) => fs.writeFileSync(new URL(`./out/${o.id}.json`, import.meta.url), JSON.stringify(o));
const slip = { type: 'slip' }, wall = { type: 'wall' };

function duct(kind) {
  const N = 20, L = 240, dx = 10, Re = 40, ulat = 0.05, U = 0.1;
  const Dh = kind === 'pipe' ? 18 : N, nu = U * Dh * dx / 1000 / Re;
  const c = { Lx: L * dx, Ly: N * dx, Lz: N * dx, Nx: L, fluid: { nu, rho: 1 }, les: { enabled: false }, u_lat_max: ulat, duration: 1e9, ramp: 2, sponge: 0,
    faces: { xmin: { type: 'velocity', ux: U }, xmax: { type: 'pressure', p: 0 }, ymin: wall, ymax: wall, zmin: wall, zmax: wall }, objects: [] };
  if (kind === 'pipe') c.objects.push({ name: 'pipe', mesh: { gen: { type: 'tube', ri: Dh / 2 * dx, ro: N * dx, len: L * dx + 40 } }, pos: [L * dx / 2, N * dx / 2, N * dx / 2], voxel: 'solid' });
  const S = buildSetup(c), s = new CPUSolver(S), { Nx, Ny, Nz } = S.prm, steps = 14000;
  for (let n = 0; n < steps; n += 1000) { s.run(1000); process.stdout.write(`${kind} ${n + 1000}\r`); }
  const m = s.macro, at = (x, y, z) => 4 * (x + Nx * (y + Ny * z));
  const xs = Math.round(0.75 * Nx), zc = Nz / 2;
  let q = 0, area = 0;
  for (let z = 0; z < Nz; z++) for (let y = 0; y < Ny; y++) if (m[at(xs, y, z) + 3]) { q += m[at(xs, y, z)]; area++; }
  const ub = q / area, sec = (x) => { let r = 0, n = 0; for (let z = 0; z < Nz; z++) for (let y = 0; y < Ny; y++) if (m[at(x, y, z) + 3]) { r += m[at(x, y, z) + 3]; n++; } return r / n; };
  const x1 = Math.round(0.5 * Nx), x2 = Math.round(0.85 * Nx), dpdx = (sec(x2) - sec(x1)) / 3 / (x2 - x1);
  const nuL = S.prm.nu_lat, dhL = kind === 'pipe' ? Dh : N, fRe = -dpdx * dhL / (0.5 * ub * ub) * (ub * dhL / nuL);
  const prof = [];
  for (let y = 0; y < Ny; y++) { const v = 0.5 * (m[at(xs, y, Math.floor(zc - 0.5))] + m[at(xs, y, Math.ceil(zc - 0.5))]); prof.push([(y + 0.5) / Ny, m[at(xs, y, Math.floor(zc)) + 3] ? v / ub : null]); }
  const ana = [];
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    if (kind === 'pipe') { const r = Math.abs(t - 0.5) * 2 * (N / Dh); ana.push([t, r <= 1 ? 2 * (1 - r * r) : 0]); }
    else ana.push([t, ductProfile(t, 0.5)]);
  }
  let umax = 0; for (const [, v] of prof) if (v) umax = Math.max(umax, v);
  const ref = kind === 'pipe' ? { fRe: 64, umax: 2 } : { fRe: 56.91, umax: 2.096 };
  out({ id: kind === 'pipe' ? '3d_pipe' : '3d_duct', grid: [Nx, Ny, Nz], Re, steps, fRe, umax, ref, prof, ana, tau0: S.prm.tau0 });
  console.log(kind, 'fRe', fRe.toFixed(2), 'ref', ref.fRe, 'umax/ub', umax.toFixed(3), 'ref', ref.umax);
}

function ductProfile(y, z) {
  const a = 0.5, sum = (yy, zz) => { let s = 0; for (let i = 1; i < 60; i += 2) s += (-1) ** ((i - 1) / 2) * (1 - Math.cosh(i * Math.PI * zz / (2 * a)) / Math.cosh(i * Math.PI / 2)) * Math.cos(i * Math.PI * yy / (2 * a)) / i ** 3; return s; };
  let mean = 0; const n = 40;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) mean += sum((i + 0.5) / n - 0.5, (j + 0.5) / n - 0.5);
  mean /= n * n;
  return sum(y - 0.5, z - 0.5) / mean;
}

function sphere(Re) {
  const D = +(process.env.D || 10), dx = 10, U = 0.1, L = 15 * D, H = 6 * D;
  const c = { Lx: L * dx, Ly: H * dx, Lz: H * dx, Nx: L, fluid: { nu: U * D * dx / 1000 / Re, rho: 1 }, les: { enabled: false }, u_lat_max: 0.05, duration: 1e9, ramp: 4, sponge: 10,
    faces: { xmin: { type: 'velocity', ux: U }, xmax: { type: 'pressure', p: 0 }, ymin: slip, ymax: slip, zmin: slip, zmax: slip },
    objects: [{ name: 'sphere', mesh: { gen: { type: 'sphere', r: D * dx / 2, seg: 40 } }, pos: [4.5 * D * dx, H * dx / 2 + 0.2 * dx, H * dx / 2 + 0.1 * dx], voxel: 'solid' }] };
  const S = buildSetup(c), s = new CPUSolver(S), q = 0.5 * 0.05 ** 2 * Math.PI * D * D / 4, steps = +(process.env.STEPS || 10000), hist = [];
  for (let n = 0; n < steps; n += 100) { s.run(100); hist.push([s.step, s.loads[0] / q]); if (n % 1000 === 0) process.stdout.write(`sphere ${Re} ${n} ${(s.loads[0] / q).toFixed(3)}\n`); }
  const tail = hist.slice(-20), cd = tail.reduce((a, b) => a + b[1], 0) / tail.length;
  const sn = 24 / Re * (1 + 0.15 * Re ** 0.687);
  out({ id: `3d_sphere_${Re}`, Re, D, grid: [S.prm.Nx, S.prm.Ny, S.prm.Nz], cd, sn, hist: hist.filter((_, i) => i % 3 === 0), tau0: S.prm.tau0 });
  console.log('sphere', Re, 'Cd', cd.toFixed(4), 'SN', sn.toFixed(4));
}

if (name === 'duct') duct('duct');
else if (name === 'pipe') duct('pipe');
else if (name === 'sphere') sphere(arg);
