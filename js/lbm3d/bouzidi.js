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

export const BOUZIDI_MAX_TRIS = 3000000;

export function linkDistances(objs, base, Nx, Ny, Nz) {
  const N = Nx * Ny * Nz, NxNy = Nx * Ny, qoff = new Uint32Array(N);
  let total = 0;
  for (const o of objs) total += o.f.length / 3;
  if (!objs.length || total > BOUZIDI_MAX_TRIS) return { qoff, qtab: new Uint32Array(1), links: 0, hits: 0, skipped: total > BOUZIDI_MAX_TRIS ? total : 0 };
  const objOf = new Map(objs.map((o, n) => [o.oi, n])), triStart = [];
  const range = (o, t, cb) => {
    const v = o.v, f = o.f, a = f[t] * 3, b = f[t + 1] * 3, c = f[t + 2] * 3, lo = [], hi = [];
    for (let d = 0; d < 3; d++) {
      lo.push(Math.max(0, Math.floor(Math.min(v[a + d], v[b + d], v[c + d]) - 1e-6)));
      hi.push(Math.min([Nx, Ny, Nz][d] - 1, Math.floor(Math.max(v[a + d], v[b + d], v[c + d]) + 1e-6)));
    }
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) cb(i + Nx * (j + Ny * k));
  };
  const near = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    if ((base[k] & 3) !== 1) continue;
    const x = k % Nx, y = Math.floor(k / Nx) % Ny, z = Math.floor(k / NxNy);
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy, zz = z + dz;
      if (xx >= 0 && yy >= 0 && zz >= 0 && xx < Nx && yy < Ny && zz < Nz) near[xx + Nx * (yy + Ny * zz)] = 1;
    }
  }
  const count = new Uint32Array(N + 1);
  let g = 0;
  objs.forEach((o) => { triStart.push(g); for (let t = 0; t < o.f.length; t += 3) range(o, t, (c) => { if (near[c]) count[c + 1]++; }); g += o.f.length / 3; });
  for (let k = 0; k < N; k++) count[k + 1] += count[k];
  const list = new Uint32Array(count[N]), fill = count.slice(0, N);
  objs.forEach((o, n) => { for (let t = 0; t < o.f.length; t += 3) { const gt = triStart[n] + t / 3; range(o, t, (c) => { if (near[c]) list[fill[c]++] = gt; }); } });
  const objAt = (gt) => { let n = triStart.length - 1; while (triStart[n] > gt) n--; return n; };
  let links = 0, hits = 0, rows = 0;
  const codes = new Uint8Array(19), qrows = [];
  for (let z = 0; z < Nz; z++) for (let y = 0; y < Ny; y++) for (let x = 0; x < Nx; x++) {
    const k = x + Nx * y + NxNy * z;
    if ((base[k] & 3) || !near[k]) continue;
    let any = false;
    codes.fill(0);
    for (let i = 1; i < 19; i++) {
      const sx = x - EX[i], sy = y - EY[i], sz = z - EZ[i];
      if (sx < 0 || sy < 0 || sz < 0 || sx >= Nx || sy >= Ny || sz >= Nz) continue;
      const cs = base[sx + Nx * (sy + Ny * sz)];
      if ((cs & 3) !== 1) continue;
      const want = objOf.get((cs >> 2) & 255);
      if (want === undefined) continue;
      links++;
      const o = objs[want], ox = x + 0.5, oy = y + 0.5, oz = z + 0.5, dx = -EX[i], dy = -EY[i], dz = -EZ[i];
      let best = Infinity;
      for (let cz = Math.min(z, sz); cz <= Math.max(z, sz); cz++) for (let cy = Math.min(y, sy); cy <= Math.max(y, sy); cy++) for (let cx = Math.min(x, sx); cx <= Math.max(x, sx); cx++) {
        const c = cx + Nx * (cy + Ny * cz);
        for (let q = count[c]; q < count[c + 1]; q++) {
          const gt = list[q];
          if (objAt(gt) !== want) continue;
          const t = (gt - triStart[want]) * 3;
          const tt = rayTri(ox, oy, oz, dx, dy, dz, o.v, o.f[t] * 3, o.f[t + 1] * 3, o.f[t + 2] * 3);
          if (tt > 1e-4 && tt <= 1.0001 && tt < best) best = tt;
        }
      }
      if (best <= 1.0001) { codes[i] = Math.max(1, Math.min(255, Math.round(best * 255))); hits++; any = true; }
    }
    if (any) {
      for (let i = 0; i < 19; i += 4) qrows.push(codes[i] | (codes[i + 1] << 8) | ((codes[i + 2] || 0) << 16) | ((i + 3 < 19 ? codes[i + 3] : 0) << 24));
      qoff[k] = ++rows;
    }
  }
  const qtab = new Uint32Array(Math.max(1, qrows.length));
  for (let n = 0; n < qrows.length; n++) qtab[n] = qrows[n] >>> 0;
  return { qoff, qtab, links, hits, skipped: 0 };
}
