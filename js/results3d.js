import { lut, autoRange } from './lbm/render.js';
import { streamlines } from './lbm/flowviz.js';

const Q = 60000;
export const FIELD_LABEL = { umag: '|u| [m/s]', ux: 'uₓ [m/s]', uy: 'u_y [m/s]', uz: 'u_z [m/s]', pressure: 'p [Pa]', vort: 'ωₙ [1/s]' };
const LUTS = {};
const lutOf = (n) => LUTS[n] || (LUTS[n] = lut(n === 'umag' ? 'umag' : 'vort'));

export function planeDims(P, prm) {
  const { Nx, Ny, Nz } = prm;
  return P === 'X' ? [Ny, Nz] : P === 'Y' ? [Nx, Nz] : [Nx, Ny];
}

const INPLANE = { X: [1, 2], Y: [0, 2], Z: [0, 1] };

export function planeField(fr, P, field, prm, rho) {
  const d = fr[P], [w, h] = planeDims(P, prm), n = w * h, vs = prm.dx / prm.dt, out = new Float32Array(n), solid = new Uint8Array(n);
  for (let k = 0; k < n; k++) if (d.r[k] === -32768) solid[k] = 1;
  if (field === 'vort') {
    const [ia, ib] = INPLANE[P], sgn = P === 'Y' ? -1 : 1, s = vs / prm.dx / Q;
    const g = (k, c) => d.u[3 * k + c];
    for (let b = 0; b < h; b++) for (let a = 0; a < w; a++) {
      const k = a + w * b;
      if (solid[k]) continue;
      const l = a > 0 && !solid[k - 1], r = a < w - 1 && !solid[k + 1], dn = b > 0 && !solid[k - w], up = b < h - 1 && !solid[k + w];
      const dA = (c) => (l && r ? (g(k + 1, c) - g(k - 1, c)) / 2 : r ? g(k + 1, c) - g(k, c) : l ? g(k, c) - g(k - 1, c) : 0);
      const dB = (c) => (dn && up ? (g(k + w, c) - g(k - w, c)) / 2 : up ? g(k + w, c) - g(k, c) : dn ? g(k, c) - g(k - w, c) : 0);
      out[k] = sgn * (dA(ib) - dB(ia)) * s;
    }
  } else {
    for (let k = 0; k < n; k++) {
      if (solid[k]) continue;
      if (field === 'pressure') out[k] = d.r[k] / 1e5 * rho * vs * vs / 3;
      else if (field === 'umag') out[k] = Math.hypot(d.u[3 * k], d.u[3 * k + 1], d.u[3 * k + 2]) / Q * vs;
      else out[k] = d.u[3 * k + { ux: 0, uy: 1, uz: 2 }[field]] / Q * vs;
    }
  }
  return { w, h, val: out, solid };
}

export function fieldRange(field, arrays) {
  let n = 0;
  for (const a of arrays) n += a.val.length;
  const all = new Float32Array(n);
  let o = 0;
  for (const a of arrays) { for (let k = 0; k < a.val.length; k++) all[o + k] = a.solid[k] ? 0 : a.val[k]; o += a.val.length; }
  return autoRange(field === 'umag' ? 'umag' : 'vort', all);
}

export function toRGBA(pf, field, lo, hi, solidRGB) {
  const L = lutOf(field), n = pf.val.length, out = new Uint8Array(4 * n), s = (L.length - 1) / (hi - lo || 1);
  for (let k = 0; k < n; k++) {
    let c;
    if (pf.solid[k]) c = solidRGB;
    else { const t = Math.max(0, Math.min(L.length - 1, Math.round((pf.val[k] - lo) * s))); c = L[t]; }
    out[4 * k] = c[0]; out[4 * k + 1] = c[1]; out[4 * k + 2] = c[2]; out[4 * k + 3] = 255;
  }
  return out;
}

export function planeQuad(P, idx, prm) {
  const { Nx, Ny, Nz, dxmm } = prm, Lx = Nx * dxmm, Ly = Ny * dxmm, Lz = Nz * dxmm, c = (idx + 0.5) * dxmm;
  if (P === 'X') return [[c, 0, 0], [0, Ly, 0], [0, 0, Lz]];
  if (P === 'Y') return [[0, c, 0], [Lx, 0, 0], [0, 0, Lz]];
  return [[0, 0, c], [Lx, 0, 0], [0, Ly, 0]];
}

function to3(P, idx, a, b, dxmm) {
  const c = (idx + 0.5) * dxmm;
  if (P === 'X') return [c, a * dxmm, b * dxmm];
  if (P === 'Y') return [a * dxmm, c, b * dxmm];
  return [a * dxmm, b * dxmm, c];
}

export function planeVectors(fr, P, prm, stride) {
  const d = fr[P], [w, h] = planeDims(P, prm), [ia, ib] = INPLANE[P], idx = fr.idx['XYZ'.indexOf(P)], out = [];
  let um = 0;
  for (let k = 0; k < w * h; k++) if (d.r[k] !== -32768) um = Math.max(um, Math.hypot(d.u[3 * k + ia], d.u[3 * k + ib]));
  if (um <= 0) return out;
  const L = stride * 0.95;
  for (let b = Math.floor(stride / 2); b < h; b += stride) for (let a = Math.floor(stride / 2); a < w; a += stride) {
    const k = a + w * b;
    if (d.r[k] === -32768) continue;
    const ua = d.u[3 * k + ia] / um, ub = d.u[3 * k + ib] / um, m = Math.hypot(ua, ub);
    if (m < 0.03) continue;
    const x0 = a + 0.5, y0 = b + 0.5, x1 = x0 + ua * L, y1 = y0 + ub * L, hl = Math.min(0.35 * m * L, 0.45 * stride), ex = ua / m, ey = ub / m;
    const p0 = to3(P, idx, x0, y0, prm.dxmm), p1 = to3(P, idx, x1, y1, prm.dxmm);
    const h1 = to3(P, idx, x1 - hl * (ex * 0.87 - ey * 0.5), y1 - hl * (ey * 0.87 + ex * 0.5), prm.dxmm);
    const h2 = to3(P, idx, x1 - hl * (ex * 0.87 + ey * 0.5), y1 - hl * (ey * 0.87 - ex * 0.5), prm.dxmm);
    out.push(...p0, ...p1, ...p1, ...h1, ...p1, ...h2);
  }
  return out;
}

export function planeStreams(fr, P, prm) {
  const d = fr[P], [w, h] = planeDims(P, prm), [ia, ib] = INPLANE[P], n = w * h, idx = fr.idx['XYZ'.indexOf(P)];
  const ua = new Float32Array(n), ub = new Float32Array(n), solid = new Uint8Array(n);
  for (let k = 0; k < n; k++) { if (d.r[k] === -32768) { solid[k] = 1; continue; } ua[k] = d.u[3 * k + ia]; ub[k] = d.u[3 * k + ib]; }
  const lines = streamlines(ua, ub, solid, w, h, Math.max(3, Math.round(Math.max(w, h) / 40))), out = [];
  for (const ln of lines) for (let q = 0; q + 1 < ln.length; q++) out.push(...to3(P, idx, ln[q][0], ln[q][1], prm.dxmm), ...to3(P, idx, ln[q + 1][0], ln[q + 1][1], prm.dxmm));
  return out;
}

export function particleBuffers(fr, prm, uref) {
  const p = fr.parts;
  if (!p) return [null, null];
  const L = lutOf('umag'), pos = [], col = [];
  for (let q = 0; q < p.length; q += 4) {
    if (p[q + 3] < 0) continue;
    pos.push(p[q] * prm.dxmm, p[q + 1] * prm.dxmm, p[q + 2] * prm.dxmm);
    const c = L[Math.max(0, Math.min(L.length - 1, Math.round(p[q + 3] / uref * (L.length - 1))))];
    col.push(c[0] / 255, c[1] / 255, c[2] / 255);
  }
  return [pos, col];
}

export function sampleAt(fr, P, prm, point, field, rho) {
  const [w, h] = planeDims(P, prm), [ia, ib] = INPLANE[P], a = Math.floor(point[ia] / prm.dxmm), b = Math.floor(point[ib] / prm.dxmm);
  if (a < 0 || b < 0 || a >= w || b >= h) return null;
  const pf = planeField(fr, P, field, prm, rho);
  return pf.solid[a + w * b] ? NaN : pf.val[a + w * b];
}

export function legendCanvas(cv, field) {
  const g = cv.getContext('2d'), L = lutOf(field);
  for (let x = 0; x < cv.width; x++) { const c = L[Math.round(x / (cv.width - 1) * (L.length - 1))]; g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`; g.fillRect(x, 0, 1, cv.height); }
}
