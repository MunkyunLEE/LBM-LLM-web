import { EX, EY, EZ, W, OPP, REFL, bodyBuffer } from './setup.js';
import { advectCPU, initParts } from './particles3d.js';

const LES_C = 18 * Math.SQRT2;
const FLUID_WORD = 255 << 2;

function genFast() {
  const L = [], idx = [...Array(19).keys()];
  L.push('let n = 0;', 'for (let k = k0; k < k1; k++) {', 'const c = cell[k];', `if (c !== ${FLUID_WORD}) { slow[n++] = k; continue; }`);
  L.push(`if ((${idx.slice(1).map((i) => `cell[k - off${i}]`).join(' | ')}) & 3) { slow[n++] = k; continue; }`);
  for (const i of idx) L.push(`const f${i} = A[${i} * N + k - off${i}];`);
  const sum = (fn) => idx.map((i) => { const v = fn(i); return v === 0 ? '' : v === 1 ? `+f${i}` : v === -1 ? `-f${i}` : `+${v}*f${i}`; }).join('') || '0';
  L.push(`const r = ${sum(() => 1)};`, 'const ir = 1 / r;');
  L.push(`const ux = (${sum((i) => EX[i])}) * ir, uy = (${sum((i) => EY[i])}) * ir, uz = (${sum((i) => EZ[i])}) * ir;`);
  L.push('const usq = 1.5 * (ux * ux + uy * uy + uz * uz);');
  for (const i of idx) {
    const eu = [[EX[i], 'ux'], [EY[i], 'uy'], [EZ[i], 'uz']].filter(([e]) => e).map(([e, u]) => (e > 0 ? '+' : '-') + u).join('') || '0';
    L.push(`const e${i} = ${eu}; const q${i} = ${W[i]} * r * (1 + 3 * e${i} + 4.5 * e${i} * e${i} - usq); const d${i} = f${i} - q${i};`);
  }
  const pi = (a, b) => idx.map((i) => { const v = [EX[i], EY[i], EZ[i]][a] * [EX[i], EY[i], EZ[i]][b]; return v === 0 ? '' : v > 0 ? `+d${i}` : `-d${i}`; }).join('') || '0';
  L.push(`const pxx = ${pi(0, 0)}, pyy = ${pi(1, 1)}, pzz = ${pi(2, 2)}, pxy = ${pi(0, 1)}, pxz = ${pi(0, 2)}, pyz = ${pi(1, 2)};`);
  L.push('let tau = t0;', `if (cs2 > 0) tau = 0.5 * (t0 + Math.sqrt(t0 * t0 + ${LES_C} * cs2 * Math.sqrt(pxx * pxx + pyy * pyy + pzz * pzz + 2 * (pxy * pxy + pxz * pxz + pyz * pyz)) * ir));`);
  L.push('const a = 4.5 * (1 - 1 / tau), tr = (pxx + pyy + pzz) / 3;');
  L.push('let sg = 0;', 'if (sponge !== null && sponge[k] > 0) { const rb = rbar[k] + alpha * (r - rbar[k]); rbar[k] = rb; sg = sponge[k] * (rb - r); }');
  for (const i of idx) {
    const e = [EX[i], EY[i], EZ[i]], t = [];
    if (e[0]) t.push('pxx'); if (e[1]) t.push('pyy'); if (e[2]) t.push('pzz');
    if (e[0] * e[1]) t.push(`${e[0] * e[1] > 0 ? '+' : '-'}2*pxy`); if (e[0] * e[2]) t.push(`${e[0] * e[2] > 0 ? '+' : '-'}2*pxz`); if (e[1] * e[2]) t.push(`${e[1] * e[2] > 0 ? '+' : '-'}2*pyz`);
    const ex = t.length ? t.join('+').replace(/\+-/g, '-').replace(/\+\+/g, '+') : '0';
    L.push(`B[${i} * N + k] = q${i} + ${W[i]} * a * (${ex} - tr) + (sg ? sg * ${W[i]} * (1 + 3 * e${i} + 4.5 * e${i} * e${i} - usq) : 0);`);
  }
  L.push('const m = 4 * k; macro[m] = ux; macro[m + 1] = uy; macro[m + 2] = uz; macro[m + 3] = r;');
  L.push('if (inv > 0) { mean[m] += (ux - mean[m]) * inv; mean[m + 1] += (uy - mean[m + 1]) * inv; mean[m + 2] += (uz - mean[m + 2]) * inv; mean[m + 3] += (r - mean[m + 3]) * inv; }', '}', 'return n;');
  const args = ['A', 'B', 'cell', 'macro', 'mean', 'inv', 'sponge', 'rbar', 'alpha', 'slow', 'k0', 'k1', 'N', 't0', 'cs2', ...idx.map((i) => `off${i}`)];
  return new Function(...args, L.join('\n'));
}
const FAST = genFast();

export class CPUSolver {
  constructor(S) {
    this.S = S;
    const { Nx, Ny, Nz } = S.prm, N = S.N;
    Object.assign(this, { Nx, Ny, Nz, N, NxNy: Nx * Ny });
    this.A = new Float32Array(19 * N); this.B = new Float32Array(19 * N);
    for (let i = 0; i < 19; i++) this.A.fill(W[i], i * N, (i + 1) * N);
    this.cell = Uint32Array.from(S.base);
    this.macro = new Float32Array(4 * N);
    for (let k = 0; k < N; k++) this.macro[4 * k + 3] = 1;
    const bb = bodyBuffer(S.bodies);
    this.body = bb.B; this.occ = bb.occ; this.nbody = S.bodies.length;
    this.bodyOf = new Int16Array(256).fill(-1);
    S.bodies.forEach((b, i) => { this.bodyOf[b.owner] = i; });
    this.acc = new Float64Array(8 * Math.max(1, S.nobj)); this.loads = new Float32Array(6 * Math.max(1, S.nobj)); this.lsum = new Float64Array(this.loads.length); this.lcount = 0;
    this.step = 0; this.ramp = 0;
    this.off = EX.map((_, i) => EX[i] + Nx * EY[i] + Nx * Ny * EZ[i]);
    this.f = new Float64Array(19); this.fq = new Float64Array(19);
    this.sponge = this.buildSponge();
    this.rbar = new Float32Array(N).fill(1);
    this.per = [0, 1, 2].map((a) => S.bcf[2 * a * 8] === 5);
    this.navg = 0;
    this.mean = S.avgStart < S.prm.steps ? new Float32Array(4 * N) : null;
    this.voxel(false);
  }

  buildSponge() {
    const { Nx, Ny, Nz, N, S } = this, bc = S.bcf;
    let any = false;
    for (let fc = 0; fc < 6; fc++) if (bc[fc * 8 + 2] > 0) any = true;
    if (!any) return null;
    const sp = new Float32Array(N), Ns = [Nx, Ny, Nz];
    for (let z = 0; z < Nz; z++) for (let y = 0; y < Ny; y++) for (let x = 0; x < Nx; x++) {
      const p = [x, y, z];
      let s = 0;
      for (let fc = 0; fc < 6; fc++) {
        const w = bc[fc * 8 + 2];
        if (!(w > 0)) continue;
        const a = fc >> 1, d = fc & 1 ? Ns[a] - 1 - p[a] : p[a];
        if (d < w) s = Math.max(s, 0.08 * (1 - d / (w - 1 || 1)) ** 2);
      }
      sp[x + Nx * (y + Ny * z)] = s;
    }
    return sp;
  }

  inside(b, X, Y, Z) {
    const B = this.body, o = b * 32;
    const dx = X - B[o], dy = Y - B[o + 1], dz = Z - B[o + 2], rb = B[o + 16];
    if (dx * dx + dy * dy + dz * dz > rb * rb) return false;
    const ax = B[o + 4], ay = B[o + 5], az = B[o + 6], th = B[o + 8], c = Math.cos(th), s = -Math.sin(th);
    const cx = ay * dz - az * dy, cy = az * dx - ax * dz, cz = ax * dy - ay * dx, ad = (ax * dx + ay * dy + az * dz) * (1 - c);
    const h = B[o + 18], nx = B[o + 24], ny = B[o + 25], nz = B[o + 26];
    const i = Math.floor((B[o] + dx * c + cx * s + ax * ad - B[o + 20]) / h);
    const j = Math.floor((B[o + 1] + dy * c + cy * s + ay * ad - B[o + 21]) / h);
    const k = Math.floor((B[o + 2] + dz * c + cz * s + az * ad - B[o + 22]) / h);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return false;
    const q = i + nx * (j + ny * k), w = this.occ[B[o + 19] + (q >> 5)];
    return ((w >>> (q & 31)) & 1) === 1;
  }

  wallVel(b, X, Y, Z, out) {
    const B = this.body, o = b * 32, w = B[o + 9];
    const dx = X - B[o], dy = Y - B[o + 1], dz = Z - B[o + 2], ax = B[o + 4] * w, ay = B[o + 5] * w, az = B[o + 6] * w;
    out[0] = ay * dz - az * dy; out[1] = az * dx - ax * dz; out[2] = ax * dy - ay * dx;
  }

  voxel(refill) {
    if (!this.nbody) return;
    const { Nx, Ny, Nz, N, cell, S, body } = this, base = S.base, uw = [0, 0, 0];
    for (let b = 0; b < this.nbody; b++) {
      const o = b * 32, rb = body[o + 16];
      const x0 = Math.max(0, Math.floor(body[o] - rb)), x1 = Math.min(Nx - 1, Math.ceil(body[o] + rb));
      const y0 = Math.max(0, Math.floor(body[o + 1] - rb)), y1 = Math.min(Ny - 1, Math.ceil(body[o + 1] + rb));
      const z0 = Math.max(0, Math.floor(body[o + 2] - rb)), z1 = Math.min(Nz - 1, Math.ceil(body[o + 2] + rb));
      for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const k = x + Nx * (y + Ny * z), old = cell[k], bs = base[k];
        let nc = bs;
        if ((bs & 3) === 0) {
          for (let q = 0; q < this.nbody; q++) if (this.inside(q, x + 0.5, y + 0.5, z + 0.5)) { nc = 2 | (body[q * 32 + 7] << 2) | (bs & (255 << 10)); break; }
        }
        if (nc === old) continue;
        cell[k] = nc;
        if (refill && (old & 3) === 2 && (nc & 3) === 0) {
          const ob = this.bodyOf[(old >> 2) & 255];
          this.wallVel(ob, x + 0.5, y + 0.5, z + 0.5, uw);
          const usq = 1.5 * (uw[0] * uw[0] + uw[1] * uw[1] + uw[2] * uw[2]);
          for (let i = 0; i < 19; i++) { const eu = EX[i] * uw[0] + EY[i] * uw[1] + EZ[i] * uw[2]; this.B[i * N + k] = W[i] * (1 + 3 * eu + 4.5 * eu * eu - usq); }
          this.macro.set([uw[0], uw[1], uw[2], 1], 4 * k);
        }
      }
    }
  }

  stream() {
    const { Nx, Ny, Nz, NxNy, off } = this;
    if (!this.slowBuf) this.slowBuf = new Int32Array(Nx);
    const sb = this.slowBuf;
    for (let z = 0; z < Nz; z++) for (let y = 0; y < Ny; y++) {
      const k0 = Nx * y + NxNy * z;
      if (y === 0 || y === Ny - 1 || z === 0 || z === Nz - 1) { for (let x = 0; x < Nx; x++) this.cellSlow(x, y, z); continue; }
      this.cellSlow(0, y, z); this.cellSlow(Nx - 1, y, z);
      const n = FAST(this.A, this.B, this.cell, this.macro, this.mean, this.mean && this.navg ? 1 / this.navg : 0, this.sponge, this.rbar, this.S.alpha, sb, k0 + 1, k0 + Nx - 1, this.N, this.S.prm.tau0, this.S.cs2, ...off);
      for (let q = 0; q < n; q++) this.cellSlow(sb[q] - k0, y, z);
    }
  }

  cellSlow(x, y, z) {
    const { Nx, Ny, Nz, N, NxNy, A, B, cell, macro, S, off, f, fq, acc, sponge } = this;
    const bc = S.bcf, refs = S.refs, t0 = S.prm.tau0, cs2 = S.cs2, ramp = this.ramp, uw = this.uw || (this.uw = [0, 0, 0]);
    {
      const yb = y === 0 || y === Ny - 1 || z === 0 || z === Nz - 1;
      {
        const k = x + Nx * y + NxNy * z, c = cell[k];
        if (c & 3) { macro[4 * k] = 0; macro[4 * k + 1] = 0; macro[4 * k + 2] = 0; macro[4 * k + 3] = 0; return; }
        const border = yb || x === 0 || x === Nx - 1, pid = (c >> 10) & 255;
        let cown = -1, fx = 0, fy = 0, fz = 0, mx = 0, my = 0, mz = 0, dd = 0;
        for (let i = 0; i < 19; i++) {
          let sx = x - EX[i], sy = y - EY[i], sz = z - EZ[i];
          if (border) {
            if (this.per[0]) sx = (sx + Nx) % Nx;
            if (this.per[1]) sy = (sy + Ny) % Ny;
            if (this.per[2]) sz = (sz + Nz) % Nz;
          }
          if (!border || (sx >= 0 && sx < Nx && sy >= 0 && sy < Ny && sz >= 0 && sz < Nz)) {
            const s = border ? sx + Nx * (sy + Ny * sz) : k - off[i], cs = cell[s];
            if ((cs & 3) === 0) { f[i] = A[i * N + s]; continue; }
            const fo = A[OPP[i] * N + k], own = (cs >> 2) & 255;
            const X = x + 0.5 - 0.5 * EX[i], Y = y + 0.5 - 0.5 * EY[i], Z = z + 0.5 - 0.5 * EZ[i];
            let fi = fo;
            if ((cs & 3) === 2) {
              this.wallVel(this.bodyOf[own], X, Y, Z, uw);
              fi += 6 * W[i] * (EX[i] * uw[0] + EY[i] * uw[1] + EZ[i] * uw[2]);
            }
            f[i] = fi;
            if (own !== 255) {
              if (own !== cown) {
                if (cown >= 0) { const q = cown * 8; acc[q] += fx; acc[q + 1] += fy; acc[q + 2] += fz; acc[q + 3] += mx; acc[q + 4] += my; acc[q + 5] += mz; acc[q + 6] += dd; }
                cown = own; fx = fy = fz = mx = my = mz = dd = 0;
              }
              const g = 2 * W[i] - fo - fi, Fx = g * EX[i], Fy = g * EY[i], Fz = g * EZ[i];
              const rx = X - refs[own * 4], ry = Y - refs[own * 4 + 1], rz = Z - refs[own * 4 + 2];
              fx += Fx; fy += Fy; fz += Fz; mx += ry * Fz - rz * Fy; my += rz * Fx - rx * Fz; mz += rx * Fy - ry * Fx;
              if ((cs & 3) === 2) {
                const bo = this.bodyOf[own] * 32, B = this.body;
                const ra = B[bo + 4] * (ry * EZ[i] - rz * EY[i]) + B[bo + 5] * (rz * EX[i] - rx * EZ[i]) + B[bo + 6] * (rx * EY[i] - ry * EX[i]);
                dd += 6 * W[i] * ra * ra;
              }
            }
            continue;
          }
          let e = -1, nf = 0, wallish = false;
          const fc0 = sx < 0 ? 0 : sx >= Nx ? 1 : -1, fc1 = sy < 0 ? 2 : sy >= Ny ? 3 : -1, fc2 = sz < 0 ? 4 : sz >= Nz ? 5 : -1;
          for (const fc of [fc0, fc1, fc2]) {
            if (fc < 0) continue;
            const ent = pid && bc[(5 + pid) * 8 + 3] === fc ? 5 + pid : fc, t = bc[ent * 8];
            if (t < 2) wallish = true;
            if (e < 0) e = ent;
            nf++;
          }
          let t = bc[e * 8];
          if (nf > 1 && wallish) t = 0;
          const o = OPP[i];
          if (t === 0) f[i] = A[o * N + k];
          else if (t === 2) {
            const pc = e < 6 ? bc[e * 8 + 7] : 0, zr = bc[e * 8 + 3], zc = z + 0.5;
            const fac = ramp * (pc > 0 ? Math.pow(zc / zr, pc) : pc < 0 ? Math.log((zc - pc) / -pc) / Math.log((zr - pc) / -pc) : 1);
            const ux = bc[e * 8 + 4] * fac, uy = bc[e * 8 + 5] * fac, uz = bc[e * 8 + 6] * fac;
            f[i] = A[o * N + k] + 6 * W[i] * (EX[i] * ux + EY[i] * uy + EZ[i] * uz);
          } else if (t === 3) {
            const ux = macro[4 * k], uy = macro[4 * k + 1], uz = macro[4 * k + 2], eu = EX[i] * ux + EY[i] * uy + EZ[i] * uz;
            f[i] = -A[o * N + k] + 2 * W[i] * bc[e * 8 + 1] * (1 + 4.5 * eu * eu - 1.5 * (ux * ux + uy * uy + uz * uz));
          } else {
            const tx = fc0 >= 0 ? x : sx, ty = fc1 >= 0 ? y : sy, tz = fc2 >= 0 ? z : sz, ts = tx + Nx * ty + NxNy * tz;
            const ok = (cell[ts] & 3) === 0;
            if (t === 1) f[i] = ok ? A[REFL[fc0 >= 0 ? 0 : fc1 >= 0 ? 1 : 2][i] * N + ts] : A[o * N + k];
            else f[i] = ok ? A[i * N + ts] : A[i * N + k];
          }
        }
        if (cown >= 0) { const q = cown * 8; acc[q] += fx; acc[q + 1] += fy; acc[q + 2] += fz; acc[q + 3] += mx; acc[q + 4] += my; acc[q + 5] += mz; acc[q + 6] += dd; }
        let r = 0, jx = 0, jy = 0, jz = 0;
        for (let i = 0; i < 19; i++) { const v = f[i]; r += v; jx += v * EX[i]; jy += v * EY[i]; jz += v * EZ[i]; }
        const ux = jx / r, uy = jy / r, uz = jz / r, usq = 1.5 * (ux * ux + uy * uy + uz * uz);
        let pxx = 0, pyy = 0, pzz = 0, pxy = 0, pxz = 0, pyz = 0;
        for (let i = 0; i < 19; i++) {
          const eu = EX[i] * ux + EY[i] * uy + EZ[i] * uz, q = W[i] * r * (1 + 3 * eu + 4.5 * eu * eu - usq), d = f[i] - q;
          fq[i] = q;
          pxx += d * EX[i] * EX[i]; pyy += d * EY[i] * EY[i]; pzz += d * EZ[i] * EZ[i];
          pxy += d * EX[i] * EY[i]; pxz += d * EX[i] * EZ[i]; pyz += d * EY[i] * EZ[i];
        }
        let tau = t0;
        if (cs2 > 0) tau = 0.5 * (t0 + Math.sqrt(t0 * t0 + LES_C * cs2 * Math.sqrt(pxx * pxx + pyy * pyy + pzz * pzz + 2 * (pxy * pxy + pxz * pxz + pyz * pyz)) / r));
        const a = 4.5 * (1 - 1 / tau), tr = (pxx + pyy + pzz) / 3;
        let rt = r, vx = ux, vy = uy, vz = uz, replace = false;
        if (pid && bc[(5 + pid) * 8 + 3] === 6) {
          replace = true;
          const e = (5 + pid) * 8;
          if (bc[e] === 2) { rt = 1; vx = bc[e + 4] * ramp; vy = bc[e + 5] * ramp; vz = bc[e + 6] * ramp; } else rt = bc[e + 1];
        }
        let sg = 0;
        if (sponge && sponge[k] > 0) { const rb = this.rbar[k] + S.alpha * (r - this.rbar[k]); this.rbar[k] = rb; sg = sponge[k] * (rb - r); }
        const vsq = 1.5 * (vx * vx + vy * vy + vz * vz);
        for (let i = 0; i < 19; i++) {
          const cx = EX[i], cy = EY[i], cz = EZ[i];
          const ne = W[i] * a * (cx * cx * pxx + cy * cy * pyy + cz * cz * pzz + 2 * (cx * cy * pxy + cx * cz * pxz + cy * cz * pyz) - tr);
          let eq = fq[i];
          if (replace) { const eu = cx * vx + cy * vy + cz * vz; eq = W[i] * rt * (1 + 3 * eu + 4.5 * eu * eu - vsq); }
          let v = eq + ne;
          if (sg) { const eu = cx * ux + cy * uy + cz * uz; v += sg * W[i] * (1 + 3 * eu + 4.5 * eu * eu - usq); }
          B[i * N + k] = v;
        }
        macro[4 * k] = ux; macro[4 * k + 1] = uy; macro[4 * k + 2] = uz; macro[4 * k + 3] = r;
        if (this.mean && this.navg) {
          const mm = this.mean, m = 4 * k, inv = 1 / this.navg;
          mm[m] += (ux - mm[m]) * inv; mm[m + 1] += (uy - mm[m + 1]) * inv; mm[m + 2] += (uz - mm[m + 2]) * inv; mm[m + 3] += (r - mm[m + 3]) * inv;
        }
      }
    }
  }

  bodyStep() {
    const { body, acc, loads, S } = this;
    for (let b = 0; b < this.nbody; b++) {
      const o = b * 32, mode = body[o + 3], own = body[o + 7], q = own * 8;
      const D = acc[q + 6], T = acc[q + 3] * body[o + 4] + acc[q + 4] * body[o + 5] + acc[q + 5] * body[o + 6] + D * body[o + 9];
      let th = body[o + 8], w = body[o + 9];
      if (mode === 3) w = body[o + 15] * this.ramp;
      else {
        const Ia = body[o + 27] + 8 * D, I = body[o + 10] + Ia, K = body[o + 11], C = body[o + 12], wm = body[o + 23], wp = body[o + 28];
        body[o + 28] = w;
        w = (I * w + T - K * th + Ia * (w - wp)) / (I + C + K + D);
        w = Math.max(-wm, Math.min(wm, w));
      }
      th += w;
      if (th < body[o + 13]) { th = body[o + 13]; w = 0; }
      if (th > body[o + 14]) { th = body[o + 14]; w = 0; }
      body[o + 8] = th; body[o + 9] = w;
    }
    for (let j = 0; j < loads.length; j++) { loads[j] = acc[(j / 6 | 0) * 8 + j % 6]; this.lsum[j] += loads[j]; }
    this.lcount++;
    acc.fill(0);
    this.step++;
    if (this.mean && this.step >= S.avgStart) this.navg++;
    const rs = S.rampSteps;
    this.ramp = this.step < rs ? 0.5 * (1 - Math.cos(Math.PI * this.step / rs)) : 1;
  }

  run(n) {
    for (let s = 0; s < n; s++) {
      this.stream();
      this.bodyStep();
      this.voxel(true);
      const t = this.A; this.A = this.B; this.B = t;
    }
  }

  slices(ix, iy, iz, macro = this.macro) {
    const { Nx, Ny, Nz } = this;
    const X = new Float32Array(4 * Ny * Nz), Y = new Float32Array(4 * Nx * Nz), Z = new Float32Array(4 * Nx * Ny);
    for (let z = 0; z < Nz; z++) for (let y = 0; y < Ny; y++) { const k = ix + Nx * (y + Ny * z); X.set(macro.subarray(4 * k, 4 * k + 4), 4 * (y + Ny * z)); }
    for (let z = 0; z < Nz; z++) for (let x = 0; x < Nx; x++) { const k = x + Nx * (iy + Ny * z); Y.set(macro.subarray(4 * k, 4 * k + 4), 4 * (x + Nx * z)); }
    for (let y = 0; y < Ny; y++) for (let x = 0; x < Nx; x++) { const k = x + Nx * (y + Ny * iz); Z.set(macro.subarray(4 * k, 4 * k + 4), 4 * (x + Nx * y)); }
    return { X, Y, Z };
  }

  async init() { return this; }

  async frame(sl, po, probes = []) {
    if (po) {
      if (!this.parts || this.parts.length !== 8 * po.count) this.parts = initParts(po.count, this.S.emitters, po.maxAge);
      advectCPU(this.macro, this.Nx, this.Ny, this.Nz, this.parts, this.S.emitters, po);
    }
    const s = this.slices(sl[0], sl[1], sl[2]);
    const pr = (src) => { const o = new Float32Array(4 * probes.length); probes.forEach((k, q) => o.set(src.subarray(4 * k, 4 * k + 4), 4 * q)); return o; };
    const avg = this.mean && this.navg > 0;
    const out = { step: this.step, ...s, mean: avg ? this.slices(sl[0], sl[1], sl[2], this.mean) : null, navg: avg ? this.navg : 0, probes: pr(this.macro), probesMean: avg ? pr(this.mean) : null, parts: po ? this.parts.slice() : null, bodies: this.bodyState(), loads: Float32Array.from(this.lsum, (v) => v / Math.max(1, this.lcount)), diverged: this.diverged() };
    this.lsum.fill(0); this.lcount = 0;
    return out;
  }

  resetParts() { this.parts = null; }

  async snapshot(useMean) {
    return (useMean && this.mean && this.navg ? this.mean : this.macro).slice();
  }

  destroy() {}

  bodyState() {
    const out = [];
    for (let b = 0; b < this.nbody; b++) out.push([this.body[b * 32 + 8], this.body[b * 32 + 9]]);
    return out;
  }

  diverged() {
    const m = this.macro;
    for (let k = 0; k < this.N; k += 97) { const r = m[4 * k + 3]; if (r !== r || r > 3 || (r < 0.2 && r !== 0)) return true; }
    return false;
  }
}
