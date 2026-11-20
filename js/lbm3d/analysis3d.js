export function coarsen(F, Nx, Ny, Nz) {
  const nx = Math.floor(Nx / 2), ny = Math.floor(Ny / 2), nz = Math.floor(Nz / 2), out = new Float32Array(4 * nx * ny * nz);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    let ux = 0, uy = 0, uz = 0, r = 0, n = 0;
    for (let c = 0; c < 8; c++) {
      const k = 4 * ((2 * x + (c & 1)) + Nx * ((2 * y + ((c >> 1) & 1)) + Ny * (2 * z + (c >> 2))));
      if (F[k + 3] === 0) continue;
      ux += F[k]; uy += F[k + 1]; uz += F[k + 2]; r += F[k + 3]; n++;
    }
    const o = 4 * (x + nx * (y + ny * z));
    if (n >= 4) { out[o] = ux / n; out[o + 1] = uy / n; out[o + 2] = uz / n; out[o + 3] = r / n; }
  }
  return { F: out, Nx: nx, Ny: ny, Nz: nz, scale: 2 };
}

export function sample(F, Nx, Ny, Nz, x, y, z, out) {
  const qx = x - 0.5, qy = y - 0.5, qz = z - 0.5, i0 = Math.floor(qx), j0 = Math.floor(qy), k0 = Math.floor(qz);
  const ax = qx - i0, ay = qy - j0, az = qz - k0;
  let ws = 0, ux = 0, uy = 0, uz = 0;
  for (let c = 0; c < 8; c++) {
    const i = i0 + (c & 1), j = j0 + ((c >> 1) & 1), k = k0 + (c >> 2);
    if (i < 0 || j < 0 || k < 0 || i >= Nx || j >= Ny || k >= Nz) continue;
    const m = 4 * (i + Nx * (j + Ny * k));
    if (F[m + 3] === 0) continue;
    const w = (c & 1 ? ax : 1 - ax) * ((c >> 1) & 1 ? ay : 1 - ay) * (c >> 2 ? az : 1 - az);
    ws += w; ux += w * F[m]; uy += w * F[m + 1]; uz += w * F[m + 2];
  }
  out[0] = ux; out[1] = uy; out[2] = uz;
  return ws;
}

export function streamlines3d(F, Nx, Ny, Nz, seeds, maxLines = 400) {
  let umax = 0;
  for (let k = 0; k < F.length; k += 4) if (F[k + 3]) umax = Math.max(umax, Math.hypot(F[k], F[k + 1], F[k + 2]));
  const umin = umax * 0.01, h = 0.5, maxSteps = 3 * (Nx + Ny + Nz), lines = [], u = [0, 0, 0];
  const stride = Math.max(1, Math.floor(seeds.length / 4 / maxLines));
  const trace = (x, y, z, dir) => {
    const pts = [], sp = [];
    for (let n = 0; n < maxSteps; n++) {
      if (sample(F, Nx, Ny, Nz, x, y, z, u) < 0.5) break;
      const s = Math.hypot(u[0], u[1], u[2]);
      if (s < umin) break;
      pts.push(x, y, z); sp.push(s);
      const mx = x + 0.5 * h * dir * u[0] / s, my = y + 0.5 * h * dir * u[1] / s, mz = z + 0.5 * h * dir * u[2] / s;
      if (sample(F, Nx, Ny, Nz, mx, my, mz, u) < 0.5) break;
      const s2 = Math.hypot(u[0], u[1], u[2]) || 1;
      x += h * dir * u[0] / s2; y += h * dir * u[1] / s2; z += h * dir * u[2] / s2;
      if (x < 0 || y < 0 || z < 0 || x >= Nx || y >= Ny || z >= Nz) break;
    }
    return [pts, sp];
  };
  for (let q = 0; q < seeds.length / 4; q += stride) {
    const x = seeds[4 * q], y = seeds[4 * q + 1], z = seeds[4 * q + 2];
    const [bp, bs] = trace(x, y, z, -1), [fp, fs] = trace(x, y, z, 1);
    const pts = [], sp = [];
    for (let i = bs.length - 1; i > 0; i--) { pts.push(bp[3 * i], bp[3 * i + 1], bp[3 * i + 2]); sp.push(bs[i]); }
    for (let i = 0; i < fs.length; i++) { pts.push(fp[3 * i], fp[3 * i + 1], fp[3 * i + 2]); sp.push(fs[i]); }
    if (sp.length > 6) lines.push({ pts: new Float32Array(pts), spd: new Float32Array(sp) });
  }
  return { lines, umax };
}

export function qField(F, Nx, Ny, Nz) {
  const Q = new Float32Array(Nx * Ny * Nz), NxNy = Nx * Ny;
  const g = (k, c) => F[4 * k + c];
  for (let z = 0; z < Nz; z++) for (let y = 0; y < Ny; y++) for (let x = 0; x < Nx; x++) {
    const k = x + Nx * y + NxNy * z;
    if (F[4 * k + 3] === 0) continue;
    const d = (dx, dy, dz, n, c) => {
      const kp = n < (dx ? Nx : dy ? Ny : Nz) - 1 ? k + dx + Nx * dy + NxNy * dz : k, km = n > 0 ? k - dx - Nx * dy - NxNy * dz : k;
      const vp = F[4 * kp + 3] ? g(kp, c) : 0, vm = F[4 * km + 3] ? g(km, c) : 0, den = (kp !== k) + (km !== k);
      return den ? (vp - vm) / den : 0;
    };
    const uxx = d(1, 0, 0, x, 0), uxy = d(0, 1, 0, y, 0), uxz = d(0, 0, 1, z, 0);
    const uyx = d(1, 0, 0, x, 1), uyy = d(0, 1, 0, y, 1), uyz = d(0, 0, 1, z, 1);
    const uzx = d(1, 0, 0, x, 2), uzy = d(0, 1, 0, y, 2), uzz = d(0, 0, 1, z, 2);
    Q[k] = -0.5 * (uxx * uxx + uyy * uyy + uzz * uzz) - (uxy * uyx + uxz * uzx + uyz * uzy);
  }
  return Q;
}

export function qLevel(Q, frac) {
  const pos = [];
  for (let k = 0; k < Q.length; k += Math.max(1, Math.floor(Q.length / 200000))) if (Q[k] > 0) pos.push(Q[k]);
  if (!pos.length) return 1;
  pos.sort((a, b) => a - b);
  return pos[Math.floor(0.995 * (pos.length - 1))] * frac;
}

const TETS = [[0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6]];
const CORNER = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];

export function isosurface(V, Nx, Ny, Nz, level, F) {
  const pos = [], spd = [], P = new Float32Array(24), val = new Float32Array(8), u = [0, 0, 0];
  const emit = (a, b) => {
    const t = (level - val[a]) / (val[b] - val[a] || 1e-30);
    const x = P[3 * a] + t * (P[3 * b] - P[3 * a]), y = P[3 * a + 1] + t * (P[3 * b + 1] - P[3 * a + 1]), z = P[3 * a + 2] + t * (P[3 * b + 2] - P[3 * a + 2]);
    pos.push(x, y, z);
    sample(F, Nx, Ny, Nz, x, y, z, u);
    spd.push(Math.hypot(u[0], u[1], u[2]));
  };
  for (let z = 0; z < Nz - 1; z++) for (let y = 0; y < Ny - 1; y++) for (let x = 0; x < Nx - 1; x++) {
    let lo = Infinity, hi = -Infinity;
    for (let c = 0; c < 8; c++) {
      const [dx, dy, dz] = CORNER[c], v = V[(x + dx) + Nx * ((y + dy) + Ny * (z + dz))];
      val[c] = v; lo = Math.min(lo, v); hi = Math.max(hi, v);
      P[3 * c] = x + dx + 0.5; P[3 * c + 1] = y + dy + 0.5; P[3 * c + 2] = z + dz + 0.5;
    }
    if (lo > level || hi < level) continue;
    for (const t of TETS) {
      const ins = t.filter((c) => val[c] > level), out = t.filter((c) => val[c] <= level);
      if (ins.length === 1) { emit(ins[0], out[0]); emit(ins[0], out[1]); emit(ins[0], out[2]); }
      else if (ins.length === 3) { emit(out[0], ins[0]); emit(out[0], ins[2]); emit(out[0], ins[1]); }
      else if (ins.length === 2) {
        const [a, b] = ins, [c, d] = out;
        emit(a, c); emit(a, d); emit(b, c);
        emit(b, c); emit(a, d); emit(b, d);
      }
    }
    if (pos.length > 3 * 3 * 1500000) break;
  }
  return { pos: new Float32Array(pos), spd: new Float32Array(spd) };
}

export function buildVTK(F, prm, rhoPhys, origin) {
  const { Nx, Ny, Nz, dx, dt } = prm, N = Nx * Ny * Nz, vs = dx / dt, ps = rhoPhys * vs * vs / 3;
  const head = `# vtk DataFile Version 3.0\nLBM-LLM-web 3D\nBINARY\nDATASET STRUCTURED_POINTS\nDIMENSIONS ${Nx} ${Ny} ${Nz}\nORIGIN ${origin[0] / 1000 + dx / 2} ${origin[1] / 1000 + dx / 2} ${origin[2] / 1000 + dx / 2}\nSPACING ${dx} ${dx} ${dx}\nPOINT_DATA ${N}\nVECTORS velocity float\n`;
  const h2 = '\nSCALARS pressure float 1\nLOOKUP_TABLE default\n', h3 = '\nSCALARS solid float 1\nLOOKUP_TABLE default\n';
  const enc = new TextEncoder(), a = enc.encode(head), b = enc.encode(h2), c = enc.encode(h3);
  const buf = new ArrayBuffer(a.length + 12 * N + b.length + 4 * N + c.length + 4 * N + 1), u8 = new Uint8Array(buf), dv = new DataView(buf);
  let o = 0;
  u8.set(a, o); o += a.length;
  for (let k = 0; k < N; k++) { const s = F[4 * k + 3] === 0; for (let d = 0; d < 3; d++) { dv.setFloat32(o, s ? 0 : F[4 * k + d] * vs, false); o += 4; } }
  u8.set(b, o); o += b.length;
  for (let k = 0; k < N; k++) { dv.setFloat32(o, F[4 * k + 3] === 0 ? 0 : (F[4 * k + 3] - 1) * ps, false); o += 4; }
  u8.set(c, o); o += c.length;
  for (let k = 0; k < N; k++) { dv.setFloat32(o, F[4 * k + 3] === 0 ? 1 : 0, false); o += 4; }
  u8[o] = 10;
  return buf;
}
