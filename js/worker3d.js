import { buildSetup } from './lbm3d/setup.js';
import { CPUSolver } from './lbm3d/cpu.js';
import { GPUSolver, gpuAvailable } from './lbm3d/gpu.js';
import { coarsen, streamlines3d, qField, qLevel, isosurface, buildVTK } from './lbm3d/analysis3d.js';

const Q = 60000;
let sol = null, S = null, job = null, sliceIdx = [0, 0, 0], partOpts = null, probes = [], rhoPhys = 1.2;

function post(type, data = {}, transfer = []) {
  self.postMessage({ type, ...data }, transfer);
}

function pack(fr) {
  const enc = (a) => {
    const n = a.length / 4, u = new Int16Array(3 * n), r = new Int16Array(n);
    for (let k = 0; k < n; k++) {
      const rho = a[4 * k + 3];
      if (rho === 0) { u[3 * k] = u[3 * k + 1] = u[3 * k + 2] = 0; r[k] = -32768; continue; }
      for (let d = 0; d < 3; d++) u[3 * k + d] = Math.max(-32767, Math.min(32767, Math.round(a[4 * k + d] * Q)));
      r[k] = Math.max(-32767, Math.min(32767, Math.round((rho - 1) * 100000)));
    }
    return { u, r };
  };
  let parts = null;
  if (fr.parts) {
    const P = fr.parts.length / 8;
    parts = new Float32Array(4 * P);
    for (let p = 0; p < P; p++) {
      const b = 8 * p;
      parts[4 * p] = fr.parts[b]; parts[4 * p + 1] = fr.parts[b + 1]; parts[4 * p + 2] = fr.parts[b + 2];
      parts[4 * p + 3] = fr.parts[b + 3] <= 0 ? -1 : Math.hypot(fr.parts[b + 4], fr.parts[b + 5], fr.parts[b + 6]);
    }
  }
  const mean = fr.mean ? { X: enc(fr.mean.X), Y: enc(fr.mean.Y), Z: enc(fr.mean.Z) } : null;
  return { step: fr.step, idx: sliceIdx.slice(), X: enc(fr.X), Y: enc(fr.Y), Z: enc(fr.Z), mean, navg: fr.navg || 0, probes: fr.probes ? Array.from(fr.probes) : [], probesMean: fr.probesMean ? Array.from(fr.probesMean) : null, parts, bodies: fr.bodies, loads: Array.from(fr.loads), diverged: fr.diverged };
}

function transferOf(f) {
  const t = [];
  for (const k of ['X', 'Y', 'Z']) { t.push(f[k].u.buffer, f[k].r.buffer); if (f.mean) t.push(f.mean[k].u.buffer, f.mean[k].r.buffer); }
  if (f.parts) t.push(f.parts.buffer);
  return t;
}

async function makeSolver(c, backend) {
  let want = backend;
  if (want === 'auto') want = (await gpuAvailable()) ? 'gpu' : 'cpu';
  const setup = buildSetup(c, want);
  if (setup.prm.cells > setup.prm.cap) throw new Error(setup.prm.warnings[0]);
  if (want === 'gpu') {
    try { return { s: await new GPUSolver(setup).init(), setup, backend: 'gpu' }; }
    catch (e) {
      if (backend === 'gpu') throw e;
      post('log', { msg: `GPU 초기화 실패, CPU로 계산합니다: ${e.message}` });
      const s2 = buildSetup(c, 'cpu');
      if (s2.prm.cells > s2.prm.cap) throw new Error(s2.prm.warnings[0]);
      return { s: new CPUSolver(s2), setup: s2, backend: 'cpu' };
    }
  }
  return { s: new CPUSolver(setup), setup, backend: 'cpu' };
}

async function run(c, opts) {
  if (sol) { sol.destroy(); sol = null; }
  const my = { stop: false, pause: false };
  job = my;
  post('state', { state: 'building' });
  const made = await makeSolver(c, opts.backend || 'auto');
  sol = made.s; S = made.setup;
  const prm = S.prm, steps = prm.steps, frames = Math.max(10, Math.min(400, +opts.frames || 120));
  const every = Math.max(1, Math.floor(steps / frames));
  sliceIdx = opts.slices.map((v, d) => Math.max(0, Math.min([prm.Nx, prm.Ny, prm.Nz][d] - 1, v)));
  const pcount = made.backend === 'gpu' ? (+opts.particles || 20000) : Math.min(+opts.particles || 4000, 6000);
  const nsub = Math.max(1, Math.ceil(every * prm.u_lat * 1.6 / 0.6));
  probes = opts.probes || []; rhoPhys = +(c.fluid.rho ?? 1.2);
  partOpts = { count: pcount, nsub, dt: every / nsub, maxAge: Math.max(20, Math.round(frames * 0.5)) };
  post('started', { backend: made.backend, steps, every, info: S.info, emitters: S.emitters.length / 4, prm: { Nx: prm.Nx, Ny: prm.Ny, Nz: prm.Nz, dx: prm.dx, dt: prm.dt, dxmm: prm.dxmm, origin: prm.origin, avgStart: S.avgStart } });
  const f0 = pack(await sol.frame(sliceIdx, partOpts, probes));
  post('frame', { frame: f0 }, transferOf(f0));
  let done = 0, t0 = performance.now(), chunk = made.backend === 'gpu' ? Math.min(every, 20) : Math.min(every, 5);
  post('state', { state: 'running' });
  while (done < steps && !my.stop) {
    if (my.pause) { const tp = performance.now(); await new Promise((r) => setTimeout(r, 120)); t0 += performance.now() - tp; continue; }
    const target = Math.min(steps, (Math.floor(done / every) + 1) * every);
    const ts = performance.now();
    while (done < target && !my.stop && !my.pause) {
      const n = Math.min(chunk, target - done);
      sol.run(n); done += n;
      if (made.backend === 'gpu') await sol.sync();
      const el = performance.now() - ts;
      if (el > 250) break;
      if (made.backend === 'cpu' && el > 60) { post('progress', { step: done, steps, sps: done / ((performance.now() - t0) / 1000) }); await new Promise((r) => setTimeout(r, 0)); }
    }
    const dtc = performance.now() - ts;
    if (made.backend === 'gpu' && dtc < 120 && chunk < every) chunk = Math.min(every, chunk * 2);
    if (made.backend === 'gpu' && dtc > 400 && chunk > 1) chunk = Math.max(1, chunk >> 1);
    my.rate = done / ((performance.now() - t0) / 1000);
    post('progress', { step: done, steps, sps: my.rate, mlups: my.rate * S.N / 1e6 });
    if (done % every === 0 || done >= steps) {
      const fr = pack(await sol.frame(sliceIdx, partOpts, probes));
      post('frame', { frame: fr }, transferOf(fr));
      if (fr.diverged) { post('state', { state: 'diverged' }); job = null; return; }
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  post('state', { state: my.stop ? 'stopped' : 'done' });
  if (job === my) job = null;
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.cmd === 'probe') post('probe', { gpu: await gpuAvailable() });
    else if (m.cmd === 'run') { if (job) { job.stop = true; await new Promise((r) => setTimeout(r, 200)); } await run(m.case, m.opts); }
    else if (m.cmd === 'stop') { if (job) job.stop = true; }
    else if (m.cmd === 'pause') { if (job) job.pause = !!m.on; post('state', { state: m.on ? 'paused' : 'running' }); }
    else if (m.cmd === 'probes') {
      probes = m.idx || [];
      if (!job && sol) { const fr = pack(await sol.frame(sliceIdx, null, probes)); post('reslice', { frame: fr }, transferOf(fr)); }
    } else if (m.cmd === 'analyze') {
      if (!sol) throw new Error('먼저 해석을 실행해 주세요.');
      post('busy', { msg: '3D 필드를 읽는 중…' });
      let F = await sol.snapshot(!!m.mean), dims = { Nx: S.prm.Nx, Ny: S.prm.Ny, Nz: S.prm.Nz }, scale = 1;
      if (m.kind === 'vtk') {
        const buf = buildVTK(F, S.prm, rhoPhys, S.prm.origin);
        post('vtk', { buf, mean: !!m.mean }, [buf]);
        return;
      }
      if (m.kind === 'qiso' && S.N > 3e6) { const c2 = coarsen(F, dims.Nx, dims.Ny, dims.Nz); F = c2.F; dims = c2; scale = 2; }
      if (m.kind === 'stream') {
        const r = streamlines3d(F, dims.Nx, dims.Ny, dims.Nz, S.emitters, +m.count || 300), pts = [], spd = [];
        for (const ln of r.lines) for (let i = 0; i + 1 < ln.spd.length; i++) { pts.push(ln.pts[3 * i], ln.pts[3 * i + 1], ln.pts[3 * i + 2], ln.pts[3 * i + 3], ln.pts[3 * i + 4], ln.pts[3 * i + 5]); spd.push(ln.spd[i], ln.spd[i + 1]); }
        const P = new Float32Array(pts), V = new Float32Array(spd);
        post('stream3d', { pos: P, spd: V, umax: r.umax, lines: r.lines.length }, [P.buffer, V.buffer]);
      } else {
        post('busy', { msg: 'Q-criterion 계산 중…' });
        const Qf = qField(F, dims.Nx, dims.Ny, dims.Nz), lv = qLevel(Qf, +m.frac || 0.1), iso = isosurface(Qf, dims.Nx, dims.Ny, dims.Nz, lv, F);
        if (scale !== 1) for (let i = 0; i < iso.pos.length; i++) iso.pos[i] *= scale;
        const qphys = lv / (scale * S.prm.dt) ** 2;
        post('qiso', { pos: iso.pos, spd: iso.spd, level: qphys, tris: iso.pos.length / 9 }, [iso.pos.buffer, iso.spd.buffer]);
      }
    } else if (m.cmd === 'slices') {
      sliceIdx = m.idx;
      if (!job && sol) { const fr = pack(await sol.frame(sliceIdx, null, probes)); post('reslice', { frame: fr }, transferOf(fr)); }
    } else if (m.cmd === 'voxels') {
      const st = buildSetup(m.case, 'cpu'), { Nx, Ny } = st.prm, out = [], base = st.base;
      if (st.prm.cells > 8e6) throw new Error('셀 수가 너무 많아 복셀 미리보기를 만들 수 없습니다.');
      const cell = Uint32Array.from(base);
      if (st.bodies.length) { const cs = new CPUSolver(st); cell.set(cs.cell); }
      for (let k = 0; k < cell.length; k++) {
        const c = cell[k], kind = c & 3, pid = (c >> 10) & 255;
        if (!kind && !pid) continue;
        const x = k % Nx, y = Math.floor(k / Nx) % Ny, z = Math.floor(k / (Nx * Ny));
        const neigh = (dx, dy, dz) => { const xx = x + dx, yy = y + dy, zz = z + dz; if (xx < 0 || yy < 0 || zz < 0 || xx >= Nx || yy >= Ny || zz >= st.prm.Nz) return 0; return cell[xx + Nx * (yy + Ny * zz)] & 3; };
        if (kind && neigh(1, 0, 0) && neigh(-1, 0, 0) && neigh(0, 1, 0) && neigh(0, -1, 0) && neigh(0, 0, 1) && neigh(0, 0, -1)) continue;
        out.push(x, y, z, kind ? ((c >> 2) & 255) : 1000 + pid);
      }
      const arr = new Int32Array(out);
      post('voxels', { cells: arr, dxmm: st.prm.dxmm, info: st.info }, [arr.buffer]);
    }
  } catch (e) {
    post('error', { msg: e.message || String(e) });
    post('state', { state: 'error' });
    job = null;
  }
};
