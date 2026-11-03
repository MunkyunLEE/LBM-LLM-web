const UNIT = { mm: 1, cm: 10, m: 1000, inch: 25.4 };

export function unitScale(u) {
  return UNIT[u] || 1;
}

function weld(pos, tol) {
  const map = new Map(), v = [], f = new Uint32Array(pos.length / 3);
  for (let i = 0; i < pos.length; i += 3) {
    const key = `${Math.round(pos[i] / tol)},${Math.round(pos[i + 1] / tol)},${Math.round(pos[i + 2] / tol)}`;
    let id = map.get(key);
    if (id === undefined) { id = v.length / 3; map.set(key, id); v.push(pos[i], pos[i + 1], pos[i + 2]); }
    f[i / 3] = id;
  }
  const faces = [];
  for (let t = 0; t < f.length; t += 3) if (f[t] !== f[t + 1] && f[t + 1] !== f[t + 2] && f[t] !== f[t + 2]) faces.push(f[t], f[t + 1], f[t + 2]);
  return { v: new Float32Array(v), f: new Uint32Array(faces) };
}

function bboxDiag(pos) {
  let a = [Infinity, Infinity, Infinity], b = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let d = 0; d < 3; d++) { a[d] = Math.min(a[d], pos[i + d]); b[d] = Math.max(b[d], pos[i + d]); }
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1;
}

export function parseSTL(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let pos = null;
  if (u8.length >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === u8.length) {
      pos = new Float32Array(n * 9);
      for (let t = 0; t < n; t++) for (let j = 0; j < 9; j++) pos[t * 9 + j] = dv.getFloat32(84 + t * 50 + 12 + j * 4, true);
    }
  }
  if (!pos) {
    const txt = new TextDecoder().decode(u8), out = [], re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
    let m;
    while ((m = re.exec(txt))) out.push(+m[1], +m[2], +m[3]);
    if (!out.length) throw new Error('STL에서 삼각형을 찾지 못했습니다.');
    pos = new Float32Array(out.length - (out.length % 9));
    for (let i = 0; i < pos.length; i++) pos[i] = out[i];
  }
  return weld(pos, bboxDiag(pos) * 1e-7);
}

export function parseOBJ(text) {
  const vs = [], pos = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (s.startsWith('v ')) { const p = s.split(/\s+/); vs.push([+p[1], +p[2], +p[3]]); }
    else if (s.startsWith('f ')) {
      const ids = s.split(/\s+/).slice(1).map((t) => { const i = parseInt(t.split('/')[0], 10); return i < 0 ? vs.length + i : i - 1; });
      for (let k = 1; k + 1 < ids.length; k++) for (const i of [ids[0], ids[k], ids[k + 1]]) pos.push(...vs[i]);
    }
  }
  if (!pos.length) throw new Error('OBJ에서 면을 찾지 못했습니다.');
  const p = new Float32Array(pos);
  return weld(p, bboxDiag(p) * 1e-7);
}

export function isClosed(mesh) {
  const cnt = new Map(), f = mesh.f, nv = mesh.v.length / 3;
  for (let t = 0; t < f.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = f[t + e], b = f[t + (e + 1) % 3], key = a < b ? a * nv + b : b * nv + a;
    cnt.set(key, (cnt.get(key) || 0) + 1);
  }
  for (const c of cnt.values()) if (c !== 2) return false;
  return cnt.size > 0;
}

export function rotMatrix(rx, ry, rz) {
  const a = rx * Math.PI / 180, b = ry * Math.PI / 180, c = rz * Math.PI / 180;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  return [
    cb * cc, -cb * sc, sb,
    ca * sc + sa * sb * cc, ca * cc - sa * sb * sc, -sa * cb,
    sa * sc - ca * sb * cc, sa * cc + ca * sb * sc, ca * cb,
  ];
}

export function worldVerts(obj) {
  const m = obj.mesh, R = rotMatrix(...(obj.rot || [0, 0, 0])), s = +(obj.scale ?? 1), p = obj.pos || [0, 0, 0];
  const out = new Float32Array(m.v.length);
  for (let i = 0; i < m.v.length; i += 3) {
    const x = m.v[i] * s, y = m.v[i + 1] * s, z = m.v[i + 2] * s;
    out[i] = R[0] * x + R[1] * y + R[2] * z + p[0];
    out[i + 1] = R[3] * x + R[4] * y + R[5] * z + p[1];
    out[i + 2] = R[6] * x + R[7] * y + R[8] * z + p[2];
  }
  return out;
}

export function bbox(v) {
  const a = [Infinity, Infinity, Infinity], b = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) for (let d = 0; d < 3; d++) { a[d] = Math.min(a[d], v[i + d]); b[d] = Math.max(b[d], v[i + d]); }
  return [a, b];
}

export function anchors(v) {
  const [a, b] = bbox(v), c = [0, 1, 2].map((d) => (a[d] + b[d]) / 2), out = [];
  for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) out.push([x, y, z]);
  for (let d = 0; d < 3; d++) for (const e of [a[d], b[d]]) { const p = c.slice(); p[d] = e; out.push(p); }
  return out;
}

function closestOnTri(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return [ax, ay, az];
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return [bx, by, bz];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); return [ax + t * abx, ay + t * aby, az + t * abz]; }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return [cx, cy, cz];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); return [ax + t * acx, ay + t * acy, az + t * acz]; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return [bx + t * (cx - bx), by + t * (cy - by), bz + t * (cz - bz)];
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return [ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w];
}

export function voxelize(v, f, grid, mode, band, visit) {
  const { o, h, n } = grid, nx = n[0], ny = n[1], nz = n[2];
  const cx = (i) => o[0] + (i + 0.5) * h, cy = (j) => o[1] + (j + 0.5) * h, cz = (k) => o[2] + (k + 0.5) * h;
  if (mode !== 'shell') {
    const cols = new Map(), ex = 1.3e-7 * h, ey = 2.7e-7 * h;
    for (let t = 0; t < f.length; t += 3) {
      const a = f[t] * 3, b = f[t + 1] * 3, c = f[t + 2] * 3;
      const x0 = v[a], y0 = v[a + 1], x1 = v[b], y1 = v[b + 1], x2 = v[c], y2 = v[c + 1];
      const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
      if (Math.abs(den) < 1e-20) continue;
      const i0 = Math.max(0, Math.floor((Math.min(x0, x1, x2) - o[0]) / h - 0.5)), i1 = Math.min(nx - 1, Math.ceil((Math.max(x0, x1, x2) - o[0]) / h - 0.5));
      const j0 = Math.max(0, Math.floor((Math.min(y0, y1, y2) - o[1]) / h - 0.5)), j1 = Math.min(ny - 1, Math.ceil((Math.max(y0, y1, y2) - o[1]) / h - 0.5));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const px = cx(i) + ex, py = cy(j) + ey;
        const l0 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / den, l1 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / den, l2 = 1 - l0 - l1;
        if (l0 < 0 || l1 < 0 || l2 < 0) continue;
        const z = l0 * v[a + 2] + l1 * v[b + 2] + l2 * v[c + 2], key = j * nx + i;
        let arr = cols.get(key);
        if (!arr) cols.set(key, (arr = []));
        arr.push(z);
      }
    }
    for (const [key, zs] of cols) {
      if (zs.length < 2) continue;
      zs.sort((p, q) => p - q);
      const i = key % nx, j = (key - i) / nx;
      for (let q = 0; q + 1 < zs.length; q += 2) {
        const k0 = Math.max(0, Math.ceil((zs[q] - o[2]) / h - 0.5)), k1 = Math.min(nz - 1, Math.floor((zs[q + 1] - o[2]) / h - 0.5));
        for (let k = k0; k <= k1; k++) visit(i, j, k);
      }
    }
  }
  if (mode === 'shell' || mode === 'both') {
    const r2 = band * band;
    for (let t = 0; t < f.length; t += 3) {
      const a = f[t] * 3, b = f[t + 1] * 3, c = f[t + 2] * 3, lo = [], hi = [];
      for (let d = 0; d < 3; d++) {
        lo.push(Math.max(0, Math.floor((Math.min(v[a + d], v[b + d], v[c + d]) - band - o[d]) / h - 0.5)));
        hi.push(Math.min(n[d] - 1, Math.ceil((Math.max(v[a + d], v[b + d], v[c + d]) + band - o[d]) / h - 0.5)));
      }
      for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
        const px = cx(i), py = cy(j), pz = cz(k);
        const q = closestOnTri(px, py, pz, v[a], v[a + 1], v[a + 2], v[b], v[b + 1], v[b + 2], v[c], v[c + 1], v[c + 2]);
        if ((q[0] - px) ** 2 + (q[1] - py) ** 2 + (q[2] - pz) ** 2 <= r2) visit(i, j, k);
      }
    }
  }
}

export function encodeMesh(m) {
  const r = (x) => Math.round(x * 1000) / 1000;
  return { v: Array.from(m.v, r), f: Array.from(m.f) };
}

export function decodeMesh(m) {
  return { v: Float32Array.from(m.v), f: Uint32Array.from(m.f) };
}
