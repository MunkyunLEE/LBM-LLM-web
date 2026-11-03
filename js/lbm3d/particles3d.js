export function sampleU(macro, Nx, Ny, Nz, x, y, z, out) {
  const qx = x - 0.5, qy = y - 0.5, qz = z - 0.5;
  const i0 = Math.floor(qx), j0 = Math.floor(qy), k0 = Math.floor(qz), ax = qx - i0, ay = qy - j0, az = qz - k0;
  let ws = 0, ux = 0, uy = 0, uz = 0;
  for (let c = 0; c < 8; c++) {
    const i = i0 + (c & 1), j = j0 + ((c >> 1) & 1), k = k0 + (c >> 2);
    if (i < 0 || j < 0 || k < 0 || i >= Nx || j >= Ny || k >= Nz) continue;
    const m = 4 * (i + Nx * (j + Ny * k));
    if (macro[m + 3] === 0) continue;
    const w = (c & 1 ? ax : 1 - ax) * ((c >> 1) & 1 ? ay : 1 - ay) * (c >> 2 ? az : 1 - az);
    ws += w; ux += w * macro[m]; uy += w * macro[m + 1]; uz += w * macro[m + 2];
  }
  out[0] = ux; out[1] = uy; out[2] = uz;
  return ws;
}

export function advectCPU(macro, Nx, Ny, Nz, parts, emit, o) {
  const u = [0, 0, 0], v = [0, 0, 0], ne = emit.length / 4, P = parts.length / 8;
  for (let p = 0; p < P; p++) {
    const b = 8 * p;
    let x = parts[b], y = parts[b + 1], z = parts[b + 2], age = parts[b + 3] + 1, ok = age <= o.maxAge;
    if (age <= 0) { parts[b + 3] = age; continue; }
    for (let s = 0; ok && s < o.nsub; s++) {
      if (sampleU(macro, Nx, Ny, Nz, x, y, z, u) < 0.5) { ok = false; break; }
      const hx = x + 0.5 * o.dt * u[0], hy = y + 0.5 * o.dt * u[1], hz = z + 0.5 * o.dt * u[2];
      if (sampleU(macro, Nx, Ny, Nz, hx, hy, hz, v) < 0.5) { ok = false; break; }
      x += o.dt * v[0]; y += o.dt * v[1]; z += o.dt * v[2];
      if (x < 0 || y < 0 || z < 0 || x >= Nx || y >= Ny || z >= Nz) ok = false;
    }
    if (!ok) {
      const e = 4 * Math.floor(Math.random() * ne), r = emit[e + 3];
      x = emit[e] + (Math.random() * 2 - 1) * r; y = emit[e + 1] + (Math.random() * 2 - 1) * r; z = emit[e + 2] + (Math.random() * 2 - 1) * r;
      age = 0; u[0] = u[1] = u[2] = 0;
    }
    parts[b] = x; parts[b + 1] = y; parts[b + 2] = z; parts[b + 3] = age;
    parts[b + 4] = u[0]; parts[b + 5] = u[1]; parts[b + 6] = u[2];
  }
}

export function initParts(P, emit, maxAge) {
  const parts = new Float32Array(8 * P), ne = emit.length / 4;
  for (let p = 0; p < P; p++) {
    const e = 4 * Math.floor(Math.random() * ne);
    parts.set([emit[e], emit[e + 1], emit[e + 2], -Math.floor(Math.random() * maxAge)], 8 * p);
  }
  return parts;
}
