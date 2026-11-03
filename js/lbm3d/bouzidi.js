import { EX, EY, EZ } from './setup.js';

function rayTri(ox, oy, oz, dx, dy, dz, v, a, b, c) {
  const e1x = v[b] - v[a], e1y = v[b + 1] - v[a + 1], e1z = v[b + 2] - v[a + 2];
  const e2x = v[c] - v[a], e2y = v[c + 1] - v[a + 1], e2z = v[c + 2] - v[a + 2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) return -1;
  const inv = 1 / det, tx = ox - v[a], ty = oy - v[a + 1], tz = oz - v[a + 2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return -1;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const w = (dx * qx + dy * qy + dz * qz) * inv;
  if (w < -1e-9 || u + w > 1 + 1e-9) return -1;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

export function linkDistances(objs, base, Nx, Ny, Nz) {
  const N = Nx * Ny * Nz, NxNy = Nx * Ny, qoff = new Uint32Array(N), rows = [];
  if (!objs.length) return { qoff, qtab: new Uint32Array(1), links: 0, hits: 0 };
  const byOwner = new Map(objs.map((o) => [o.oi, o]));
  const grids = new Map();
  for (const o of objs) {
    const g = new Map(), v = o.v, f = o.f;
    for (let t = 0; t < f.length; t += 3) {
      const a = f[t] * 3, b = f[t + 1] * 3, c = f[t + 2] * 3, lo = [], hi = [];
      for (let d = 0; d < 3; d++) {
        lo.push(Math.max(0, Math.floor(Math.min(v[a + d], v[b + d], v[c + d]) - 1e-6)));
        hi.push(Math.min([Nx, Ny, Nz][d] - 1, Math.floor(Math.max(v[a + d], v[b + d], v[c + d]) + 1e-6)));
      }
      for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
        const key = i + Nx * (j + Ny * k);
        let arr = g.get(key);
        if (!arr) g.set(key, (arr = []));
        arr.push(t);
      }
    }
    grids.set(o.oi, g);
  }
  let links = 0, hits = 0;
  const codes = new Uint8Array(19);
  for (let z = 0; z < Nz; z++) for (let y = 0; y < Ny; y++) for (let x = 0; x < Nx; x++) {
    const k = x + Nx * y + NxNy * z;
    if (base[k] & 3) continue;
    let any = false;
    codes.fill(0);
    for (let i = 1; i < 19; i++) {
      const sx = x - EX[i], sy = y - EY[i], sz = z - EZ[i];
      if (sx < 0 || sy < 0 || sz < 0 || sx >= Nx || sy >= Ny || sz >= Nz) continue;
      const s = sx + Nx * (sy + Ny * sz), cs = base[s];
      if ((cs & 3) !== 1) continue;
      const own = (cs >> 2) & 255, o = byOwner.get(own);
      if (!o) continue;
      links++;
      const ox = x + 0.5, oy = y + 0.5, oz = z + 0.5, dx = -EX[i], dy = -EY[i], dz = -EZ[i], g = grids.get(own);
      let best = Infinity;
      const seen = new Set();
      for (let cz = Math.min(z, sz); cz <= Math.max(z, sz); cz++) for (let cy = Math.min(y, sy); cy <= Math.max(y, sy); cy++) for (let cx = Math.min(x, sx); cx <= Math.max(x, sx); cx++) {
        const arr = g.get(cx + Nx * (cy + Ny * cz));
        if (!arr) continue;
        for (const t of arr) {
          if (seen.has(t)) continue;
          seen.add(t);
          const tt = rayTri(ox, oy, oz, dx, dy, dz, o.v, o.f[t] * 3, o.f[t + 1] * 3, o.f[t + 2] * 3);
          if (tt > 1e-4 && tt <= 1.0001 && tt < best) best = tt;
        }
      }
      if (best <= 1.0001) { codes[i] = Math.max(1, Math.min(255, Math.round(best * 255))); hits++; any = true; }
    }
    if (any) {
      rows.push(Array.from(codes));
      qoff[k] = rows.length;
    }
  }
  const qtab = new Uint32Array(Math.max(1, 5 * rows.length));
  rows.forEach((r, n) => { for (let i = 0; i < 19; i++) qtab[5 * n + (i >> 2)] |= r[i] << (8 * (i & 3)); });
  return { qoff, qtab, links, hits };
}
