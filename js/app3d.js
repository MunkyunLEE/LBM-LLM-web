import { View3D, PROBE_COLORS } from './view3d.js';
import { lut } from './lbm/render.js';
import { latticeParams3, gridDims3, FACES, meshOf, objectVerts } from './lbm3d/setup.js';
import { parseSTL, parseOBJ, unitScale, bbox, anchors, encodeMesh, isClosed } from './lbm3d/mesh.js';
import { generate } from './lbm3d/shapes.js';
import { parseDxf } from './lbm/dxf.js';
import { planeField, fieldRange, toRGBA, planeQuad, planeVectors, planeStreams, particleBuffers, sampleAt, legendCanvas, FIELD_LABEL } from './results3d.js';
import { GIFEncoder, quantize, applyPalette } from './vendor/gifenc.esm.js';

const $ = (id) => document.getElementById(id);
const STATE_KO = { idle: '대기', building: '준비 중', running: '계산 중', paused: '일시정지', done: '완료', stopped: '중지됨', diverged: '발산', error: '오류' };
const THEME_NEXT = { system: 'dark', dark: 'light', light: 'system' };
const THEME_LABEL = { system: '◐', dark: '☾', light: '☀' };
const THEME_TITLE = { system: '테마: 시스템 설정', dark: '테마: 다크', light: '테마: 라이트' };
const FACE_KO = { xmin: 'X−', xmax: 'X+', ymin: 'Y−', ymax: 'Y+', zmin: 'Z−', zmax: 'Z+' };
const FACE_COL = { velocity: '#4f8cff', pressure: '#e5534b', outflow: '#f0a13a', slip: '#3fb950', wall: '#8a94a8', periodic: '#a78bfa' };
const FLUIDS = { air: { nu: 1.5e-5, rho: 1.2 }, water: { nu: 1.0e-6, rho: 998 } };
const OBJ_HEX = ['#8fa3c7', '#c79f8f', '#8fc7a6', '#b98fc7', '#c7c08f', '#8fc2c7'];
const LUTC = {};
const lutOf = (n) => LUTC[n] || (LUTC[n] = lut(n));
const fmt = (v, d = 3) => (!Number.isFinite(v) ? '–' : (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0)) ? v.toExponential(2) : (+v.toFixed(d)).toString());
const mm = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : '–');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function defaultCase() {
  return {
    version: 3, dim: 3, name: 'untitled',
    Lx: 4000, Ly: 2400, Lz: 2400, dx: 50, origin: [0, 0, 0], backend: 'auto', clip: true, avgStart: 4, probes: [],
    fluid: { preset: 'air', nu: 1.5e-5, rho: 1.2 }, les: { enabled: true, cs: 0.15 },
    u_lat_max: 0.06, duration: 8, ramp: 1, frames: 120, sponge: 10, particles: 20000,
    faces: { xmin: { type: 'velocity', ux: 3, uy: 0, uz: 0 }, xmax: { type: 'pressure', p: 0 }, ymin: { type: 'slip' }, ymax: { type: 'slip' }, zmin: { type: 'wall' }, zmax: { type: 'slip' } },
    patches: [], objects: [],
    snap: { on: true, step: 100 },
    view: { field: 'umag', range: 'frame', slices: { X: { on: false, f: 0.35 }, Y: { on: true, f: 0.5 }, Z: { on: false, f: 0.5 } }, stride: 3, streamPlane: 'Y', psize: 2 },
  };
}

let S = defaultCase(), sel = -1, patchSel = -1, theme = 'system', view = null, worker = null, gpuInfo = undefined;
let run = null, frames = [], cur = -1, playing = null, state = 'idle', runRange = null, voxCells = null;

function toast(msg, ms = 3200) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
}

function applyTheme() {
  const light = theme === 'light' || (theme === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  $('btnTheme').textContent = THEME_LABEL[theme]; $('btnTheme').title = THEME_TITLE[theme];
  if (view) { view.applyTheme(); refreshResult(); }
  drawLoadChart();
}

const g3 = () => gridDims3(S);
const backendGuess = () => (S.backend === 'cpu' ? 'cpu' : S.backend === 'gpu' ? 'gpu' : (gpuInfo ? 'gpu' : 'cpu'));
const locked = () => ['running', 'paused', 'building'].includes(state);

function caseForSolver() {
  const c = JSON.parse(JSON.stringify({ ...S, objects: [] }));
  c.objects = S.objects.map((o) => {
    const { _mesh, ...rest } = o;
    const out = JSON.parse(JSON.stringify({ ...rest, mesh: undefined }));
    out.mesh = o.mesh.gen ? { gen: o.mesh.gen } : { v: o.mesh.v, f: o.mesh.f };
    return out;
  });
  return c;
}

function caseForSave() {
  const c = caseForSolver();
  c.objects = c.objects.map((o, i) => (o.mesh.gen ? o : { ...o, mesh: encodeMesh(meshOf(S.objects[i])) }));
  return c;
}

function loadCase(c) {
  const d = defaultCase();
  S = { ...d, ...c, fluid: { ...d.fluid, ...c.fluid }, les: { ...d.les, ...c.les }, faces: { ...d.faces, ...c.faces }, snap: { ...d.snap, ...c.snap }, view: { ...d.view, ...c.view, slices: { ...d.view.slices, ...(c.view?.slices || {}) } } };
  if (!(+c.dx > 0) && +c.Nx > 0) S.dx = +(c.Lx / c.Nx).toFixed(4);
  delete S.Nx;
  S.origin = (c.origin || [0, 0, 0]).map(Number);
  S.probes = c.probes || [];
  S.objects = (c.objects || []).map((o) => normObj(o));
  S.patches = c.patches || [];
  sel = -1; patchSel = -1; frames = []; cur = -1; run = null; runRange = null; voxCells = null;
  syncInputs(); rebuildScene(); view.camPreset('iso'); renderLoads(); drawLoadChart(); renderProbes(); drawProbeChart(); setMode('edit');
  for (const id of ['btnS3', 'btnQ', 'btnVtk']) $(id).disabled = true;
  view.setColoredLines('stream3d', null); view.setIso(null); $('anInfo').textContent = '';
  worker?.postMessage({ cmd: 'probes', idx: probeIdx() });
}

function normObj(o) {
  const n = { name: 'obj', pos: [0, 0, 0], rot: [0, 0, 0], scale: 1, role: 'solid', voxel: 'auto', inlet: { ux: 1, uy: 0, uz: 0 }, outlet: { p: 0 }, ...o };
  n.kin = { mode: 'off', axis: [1, 0, 0], axisSel: 'x', pivot: null, inertia: 'low', spring: 'mid', damping: 'low', rpm: 120, dir: 'ccw', advanced: { enabled: false }, ...(o.kin || {}) };
  if (!n.mesh.gen && !(n.mesh.v instanceof Float32Array)) n.mesh = { v: Float32Array.from(n.mesh.v), f: Uint32Array.from(n.mesh.f) };
  delete n._mesh;
  meshOf(n);
  if (!n.kin.pivot) n.kin.pivot = centerOf(n);
  return n;
}

function centerOf(o) {
  const [a, b] = bbox(objectVerts(o));
  return [0, 1, 2].map((d) => Math.round((a[d] + b[d]) / 2));
}

function syncInputs() {
  $('inLx').value = S.Lx; $('inLy').value = S.Ly; $('inLz').value = S.Lz; $('inDx').value = S.dx; $('inBackend').value = S.backend;
  [$('inOx').value, $('inOy').value, $('inOz').value] = S.origin; $('chkClip').checked = S.clip !== false; $('inAvg').value = S.avgStart ?? +(S.duration * 0.5).toFixed(2);
  $('inFluid').value = S.fluid.preset || 'custom'; $('inNu').value = S.fluid.nu; $('inRho').value = S.fluid.rho; $('inLes').checked = S.les.enabled;
  $('inDur').value = S.duration; $('inRamp').value = S.ramp; $('inFrames').value = S.frames; $('inUlat').value = S.u_lat_max; $('inSponge').value = S.sponge; $('inParts').value = S.particles;
  $('chkSnap').checked = S.snap.on; $('inSnap').value = S.snap.step;
  const v = S.view;
  $('inField').value = v.field; $('inRange').value = v.range; $('inStride').value = v.stride; $('inStreamPlane').value = v.streamPlane; $('inPsize').value = v.psize;
  for (const P of 'XYZ') { $(`sl${P}`).checked = v.slices[P].on; $(`sl${P}v`).value = Math.round(v.slices[P].f * 1000); }
  buildFaceRows(); renderObjList(); renderObjEditor(); renderPatches(); updateParams(); updateSliceText();
}

function rebuildScene() {
  const g = g3();
  view.patchSel = patchSel;
  view.setOrigin(S.origin);
  view.setDomain(g.Lx, g.Ly, g.Lz, g.dxmm, $('chkBC').checked ? S.faces : {}, $('chkBC').checked ? S.patches : [], $('chkGrid').checked);
  view.setClip(S.clip !== false);
  view.setProbes(S.probes, g.dxmm);
  view.setObjects(S.objects.map((o) => ({ ...o, mesh: meshOf(o) })), sel);
  if (voxCells && $('chkVox').checked) showVoxels(); else view.setVoxels(null);
  scheduleGuides();
}

function updateObjView(i) {
  const o = S.objects[i];
  view.objList[i] = { ...o, mesh: meshOf(o) };
  view.updateObject(i, view.objList[i]);
  scheduleGuides();
}

let guideTimer = null;
function scheduleGuides() { clearTimeout(guideTimer); guideTimer = setTimeout(updateGuides, 40); }

function updateGuides() {
  if (!view) return;
  const g = g3(), idx = sliceIdx(), prm = { Nx: g.Nx, Ny: g.Ny, Nz: g.Nz, dxmm: g.dxmm }, planes = [], cuts = [];
  'XYZ'.split('').forEach((P, a) => {
    if (!S.view.slices[P].on) return;
    planes.push({ axis: P, quad: planeQuad(P, idx[a], prm) });
    const c = S.origin[a] + (idx[a] + 0.5) * g.dxmm, segs = [];
    const lo = [0, 1, 2].map((d) => S.origin[d]), hi = [g.Lx, g.Ly, g.Lz].map((L, d) => S.origin[d] + L);
    for (const o of S.objects) {
      const v = objectVerts(o), f = meshOf(o).f;
      for (let t = 0; t < f.length; t += 3) {
        const P3 = [f[t] * 3, f[t + 1] * 3, f[t + 2] * 3], dv = P3.map((q) => v[q + a] - c), hit = [];
        for (let e = 0; e < 3; e++) {
          const p = P3[e], q = P3[(e + 1) % 3], da = dv[e], db = dv[(e + 1) % 3];
          if ((da > 0) === (db > 0) || da === db) continue;
          const s = da / (da - db);
          hit.push([v[p] + s * (v[q] - v[p]), v[p + 1] + s * (v[q + 1] - v[p + 1]), v[p + 2] + s * (v[q + 2] - v[p + 2])]);
        }
        if (hit.length !== 2) continue;
        const inside = (h) => h.every((x, d) => d === a || (x >= lo[d] - 1e-6 && x <= hi[d] + 1e-6));
        if (S.clip !== false && !inside(hit[0]) && !inside(hit[1])) continue;
        segs.push(...hit[0], ...hit[1]);
      }
    }
    cuts.push({ axis: P, segs });
  });
  view.setSliceGuides(planes, cuts);
}

function buildFaceRows() {
  const box = $('faceRows');
  box.innerHTML = '';
  for (const k of FACES) {
    const b = S.faces[k], row = document.createElement('div');
    row.className = 'face-row';
    row.innerHTML = `<span class="fname"><i style="background:${FACE_COL[b.type] || '#888'}"></i>${FACE_KO[k]}</span>
      <select data-k="type"><option value="wall">벽</option><option value="slip">미끄럼</option><option value="velocity">속도</option><option value="pressure">압력</option><option value="outflow">자유 유출</option><option value="periodic">주기</option></select>
      <label class="v1"></label><label class="v2"></label><label class="v3"></label>`;
    row.querySelector('select').value = b.type;
    row.querySelector('select').onchange = (e) => {
      const opp = FACES[FACES.indexOf(k) ^ 1], was = S.faces[k].type;
      if (e.target.value === 'periodic') S.faces[opp] = { type: 'periodic' };
      else if (was === 'periodic' && S.faces[opp].type === 'periodic') S.faces[opp] = { type: 'slip' };
      S.faces[k] = { type: e.target.value, ux: 0, uy: 0, uz: 0, p: 0 }; if (e.target.value === 'velocity') { const a = Math.floor(FACES.indexOf(k) / 2), u = [0, 0, 0]; u[a] = FACES.indexOf(k) % 2 ? -1 : 1; [S.faces[k].ux, S.faces[k].uy, S.faces[k].uz] = u; } buildFaceRows(); changed(); };
    const slots = [row.querySelector('.v1'), row.querySelector('.v2'), row.querySelector('.v3')];
    const fld = b.type === 'velocity' ? [['ux', 'uₓ'], ['uy', 'u_y'], ['uz', 'u_z']] : b.type === 'pressure' ? [['p', 'p Pa']] : [];
    fld.forEach(([key, ph], q) => {
      const inp = document.createElement('input');
      inp.type = 'number'; inp.step = key === 'p' ? '1' : '0.1'; inp.value = b[key] ?? 0; inp.title = ph; inp.placeholder = ph;
      inp.oninput = () => { S.faces[k][key] = +inp.value; changed(false); };
      slots[q].appendChild(inp);
    });
    box.appendChild(row);
    if (b.type === 'velocity') {
      const pr = b.profile || { type: 'uniform' }, sub = document.createElement('div');
      sub.className = 'face-sub';
      sub.innerHTML = `<span>분포</span><select><option value="uniform">균일</option><option value="power">멱법칙</option><option value="log">로그법칙</option></select>
        <label class="pz" title="기준 높이 z_ref [mm]"></label><label class="pa"></label><span class="pnote"></span>`;
      const selp = sub.querySelector('select');
      selp.value = pr.type || 'uniform';
      selp.onchange = () => { const t = selp.value; S.faces[k].profile = t === 'uniform' ? { type: 'uniform' } : t === 'power' ? { type: 'power', zref: 10000, alpha: 0.25 } : { type: 'log', zref: 10000, z0: 300 }; buildFaceRows(); changed(false); };
      if (pr.type === 'power' || pr.type === 'log') {
        const mk = (key, ph, step) => { const inp = document.createElement('input'); inp.type = 'number'; inp.step = step; inp.value = pr[key]; inp.title = ph; inp.placeholder = ph; inp.oninput = () => { S.faces[k].profile[key] = +inp.value; updateParams(); }; return inp; };
        sub.querySelector('.pz').appendChild(mk('zref', 'z_ref mm', '1000'));
        sub.querySelector('.pa').appendChild(pr.type === 'power' ? mk('alpha', 'α', '0.01') : mk('z0', 'z₀ mm', '10'));
        sub.querySelector('.pnote').textContent = pr.type === 'power' ? 'z_ref mm · α' : 'z_ref · z₀ mm';
      }
      box.appendChild(sub);
    }
  }
}

function renderObjList() {
  const ul = $('objList');
  ul.innerHTML = '';
  S.objects.forEach((o, i) => {
    const li = document.createElement('li');
    li.className = i === sel ? 'on' : '';
    const tag = o.role !== 'solid' ? (o.role === 'inlet' ? '유입' : '유출') : o.kin.mode !== 'off' ? { free: '자유회전', hinge: '힌지', drive: '구동' }[o.kin.mode] : '고정';
    const nt = o.mesh.gen ? '' : `${(meshOf(o).f.length / 3).toLocaleString()}△`;
    li.innerHTML = `<span class="sw" style="background:${o.color || OBJ_HEX[i % OBJ_HEX.length]}"></span><span>${o.name}</span><span class="tag">${tag}</span><span class="meta">${nt}</span>`;
    li.onclick = () => selectObj(i);
    ul.appendChild(li);
  });
}

function selectObj(i) {
  sel = i;
  view.select(i);
  renderObjList(); renderObjEditor();
  $('btnPivot').classList.remove('on'); view.pickAnchor = false;
}

function axisSelOf(a) {
  const n = Math.hypot(...a) || 1, u = a.map((x) => x / n);
  if (Math.abs(u[0]) > 0.9999) return 'x'; if (Math.abs(u[1]) > 0.9999) return 'y'; if (Math.abs(u[2]) > 0.9999) return 'z';
  return 'custom';
}

function renderObjEditor() {
  const ed = $('objEditor'), o = S.objects[sel];
  ed.classList.toggle('hidden', !o);
  if (!o) return;
  $('obName').value = o.name; $('obRole').value = o.role;
  [$('obX').value, $('obY').value, $('obZ').value] = o.pos.map((v) => +v.toFixed(2));
  [$('obRx').value, $('obRy').value, $('obRz').value] = o.rot;
  $('obScale').value = o.scale; $('obVoxel').value = o.voxel || 'auto';
  const rb = $('roleBox');
  rb.classList.toggle('hidden', o.role === 'solid');
  if (o.role === 'inlet') rb.innerHTML = `<h4>유입 영역 속도 <span class="sub">m/s</span></h4><div class="grid3"><label>uₓ<input id="riX" type="number" step="0.1" value="${o.inlet.ux}"></label><label>u_y<input id="riY" type="number" step="0.1" value="${o.inlet.uy}"></label><label>u_z<input id="riZ" type="number" step="0.1" value="${o.inlet.uz}"></label></div>`;
  else if (o.role === 'outlet') rb.innerHTML = `<h4>유출 영역 압력</h4><div class="grid2"><label>p <em>Pa</em><input id="roP" type="number" step="1" value="${o.outlet.p}"></label></div>`;
  if (o.role === 'inlet') for (const [id, k] of [['riX', 'ux'], ['riY', 'uy'], ['riZ', 'uz']]) $(id).oninput = (e) => { o.inlet[k] = +e.target.value; changed(false); };
  if (o.role === 'outlet') $('roP').oninput = (e) => { o.outlet.p = +e.target.value; changed(false); };
  $('kinBox').classList.toggle('hidden', o.role !== 'solid');
  const k = o.kin;
  $('kinMode').value = k.mode; $('kinAxis').value = k.axisSel || axisSelOf(k.axis);
  $('kinOpts').classList.toggle('hidden', k.mode === 'off');
  $('kinAxisVec').classList.toggle('hidden', $('kinAxis').value !== 'custom');
  [$('axX').value, $('axY').value, $('axZ').value] = k.axis;
  [$('pvX').value, $('pvY').value, $('pvZ').value] = k.pivot.map((v) => +(+v).toFixed(2));
  $('kinI').value = k.inertia; $('kinK').value = k.spring; $('kinC').value = k.damping; $('kinRpm').value = k.rpm; $('kinDir').value = k.dir;
  $('kinKWrap').classList.toggle('hidden', k.mode !== 'hinge');
  $('kinDrive').classList.toggle('hidden', k.mode !== 'drive');
  $('kinPresets').classList.toggle('hidden', k.mode === 'drive');
  const a = k.advanced || {};
  $('advOn').checked = !!a.enabled; $('advI').value = a.I ?? ''; $('advC').value = a.c ?? ''; $('advK').value = a.k ?? ''; $('advMin').value = a.min ?? -90; $('advMax').value = a.max ?? 90;
}

function changed(rebuild = true) {
  if (rebuild) rebuildScene(); else { view.patchSel = patchSel; const g = g3(); view.setDomain(g.Lx, g.Ly, g.Lz, g.dxmm, $('chkBC').checked ? S.faces : {}, $('chkBC').checked ? S.patches : [], $('chkGrid').checked); }
  updateParams();
}

function updateParams() {
  const be = backendGuess(), prm = latticeParams3(caseForParams(), be), box = $('params');
  const mem = be === 'gpu' ? prm.cells * 196 : prm.cells * 196;
  const rate = be === 'gpu' ? (gpuInfo && /swiftshader/i.test(gpuInfo.name) ? 2e6 : 4e8) : 3.5e6, est = prm.steps * prm.cells / rate;
  box.innerHTML = [
    ['격자', `${prm.Nx}×${prm.Ny}×${prm.Nz}`], ['셀 수', prm.cells.toLocaleString()],
    ['Δx', `${fmt(prm.dxmm)} mm`], ['Δt', `${fmt(prm.dt * 1000)} ms`],
    ['τ₀', prm.tau0.toFixed(5)], ['Re', fmt(prm.Re_L, 0)],
    ['스텝', prm.steps.toLocaleString()], ['메모리', `${(mem / 2 ** 20).toFixed(0)} MB`],
    ['장치', be === 'gpu' ? 'GPU' : 'CPU'], ['예상', est < 90 ? `~${Math.max(1, Math.round(est))} s` : `~${(est / 60).toFixed(0)} 분`],
  ].map(([a, b]) => `<b>${a}</b><span>${b}</span>`).join('');
  const fine = S.objects.filter((o) => o.simplified && prm.dxmm < 2 * o.simplified * 0.99).map((o) => o.name);
  if (fine.length) prm.warnings.push(`${fine.slice(0, 3).join(', ')}: 불러올 때 단순화 기준(Δx/2)보다 지금 Δx가 작습니다. 더 정밀하게 하려면 현재 Δx로 다시 불러오세요.`);
  $('warns').innerHTML = prm.warnings.map((w) => `<div class="warn">${w}</div>`).join('');
  const off = [S.Lx, S.Ly, S.Lz].some((L, d) => Math.abs(L - [prm.Lx, prm.Ly, prm.Lz][d]) > 1e-6);
  $('gridInfo').innerHTML = `N = ${prm.Nx} × ${prm.Ny} × ${prm.Nz} (정육면체 셀 ${fmt(prm.dxmm)} mm) · 해석 도메인 ${[prm.Lx, prm.Ly, prm.Lz].map((v) => Math.round(v).toLocaleString()).join(' × ')} mm${off ? ' · <b>입력 L이 Δx의 배수가 아니라 반올림됨</b>' : ''} · 상한 ${prm.cap.toLocaleString()} 셀 (${be.toUpperCase()})`;
  $('btnFitL').disabled = !off;
  $('btnRun').disabled = locked() || prm.cells > prm.cap;
}

function caseForParams() {
  return { ...S, objects: S.objects };
}

function bindInputs() {
  const num = (id, fn) => { $(id).oninput = () => { fn(+$(id).value); }; };
  num('inLx', (v) => { S.Lx = v; changed(); }); num('inLy', (v) => { S.Ly = v; changed(); }); num('inLz', (v) => { S.Lz = v; changed(); });
  num('inDx', (v) => { if (v > 0) { S.dx = v; changed(); } });
  $('btnFitL').onclick = () => { const g = g3(); S.Lx = g.Lx; S.Ly = g.Ly; S.Lz = g.Lz; $('inLx').value = S.Lx; $('inLy').value = S.Ly; $('inLz').value = S.Lz; changed(); };
  for (const [id, d] of [['inOx', 0], ['inOy', 1], ['inOz', 2]]) num(id, (v) => { S.origin[d] = v; changed(); });
  $('chkClip').onchange = () => { S.clip = $('chkClip').checked; view.setClip(S.clip); scheduleGuides(); };
  num('inAvg', (v) => { S.avgStart = Math.max(0, v); });
  $('btnDomToObj').onclick = () => {
    const o = cur0();
    if (!o) { toast('먼저 객체를 선택해 주세요.'); return; }
    const [a, b] = bbox(objectVerts(o)), s0 = S.snap.step || 1;
    S.origin = [(a[0] + b[0]) / 2 - S.Lx / 2, (a[1] + b[1]) / 2 - S.Ly / 2, a[2]].map((v) => Math.round(v / s0) * s0);
    [$('inOx').value, $('inOy').value, $('inOz').value] = S.origin; changed(); view.camPreset('iso');
    toast(`도메인 원점을 (${S.origin.map(mm).join(', ')}) mm로 옮겼습니다. 도메인 안에 든 부분만 해석됩니다.`, 5000);
  };
  $('inBackend').onchange = () => { S.backend = $('inBackend').value; updateParams(); };
  $('inFluid').onchange = () => { const f = FLUIDS[$('inFluid').value]; S.fluid.preset = $('inFluid').value; if (f) { S.fluid.nu = f.nu; S.fluid.rho = f.rho; $('inNu').value = f.nu; $('inRho').value = f.rho; } updateParams(); };
  num('inNu', (v) => { S.fluid.nu = v; S.fluid.preset = 'custom'; $('inFluid').value = 'custom'; updateParams(); });
  num('inRho', (v) => { S.fluid.rho = v; updateParams(); });
  $('inLes').onchange = () => { S.les.enabled = $('inLes').checked; updateParams(); };
  num('inDur', (v) => { S.duration = v; updateParams(); }); num('inRamp', (v) => { S.ramp = v; });
  num('inFrames', (v) => { S.frames = v; }); num('inUlat', (v) => { S.u_lat_max = v; updateParams(); });
  num('inSponge', (v) => { S.sponge = v; }); num('inParts', (v) => { S.particles = v; });
  $('chkSnap').onchange = () => { S.snap.on = $('chkSnap').checked; };
  num('inSnap', (v) => { S.snap.step = Math.max(1, v); });
  $('obName').oninput = () => { cur0().name = $('obName').value; renderObjList(); };
  $('obRole').onchange = () => { cur0().role = $('obRole').value; if (cur0().role !== 'solid') cur0().kin.mode = 'off'; renderObjEditor(); renderObjList(); rebuildScene(); updateParams(); };
  const tr = () => { const o = cur0(); const old = centerOf(o); o.pos = [+$('obX').value, +$('obY').value, +$('obZ').value]; o.rot = [+$('obRx').value, +$('obRy').value, +$('obRz').value]; o.scale = +$('obScale').value || 1; movePivot(o, old); updateObjView(sel); updateParams(); };
  for (const id of ['obX', 'obY', 'obZ', 'obRx', 'obRy', 'obRz', 'obScale']) $(id).onchange = tr;
  $('obVoxel').onchange = () => { cur0().voxel = $('obVoxel').value; };
  $('obFloor').onclick = () => { const o = cur0(), old = centerOf(o), [a] = bbox(objectVerts(o)); o.pos[2] -= a[2]; movePivot(o, old); updateObjView(sel); renderObjEditor(); };
  $('obCenter').onclick = () => { const o = cur0(), old = centerOf(o), g = g3(), [a, b] = bbox(objectVerts(o)); const c = [g.Lx / 2 + S.origin[0], g.Ly / 2 + S.origin[1], g.Lz / 2 + S.origin[2]]; for (let d = 0; d < 3; d++) o.pos[d] += c[d] - (a[d] + b[d]) / 2; movePivot(o, old); updateObjView(sel); renderObjEditor(); };
  $('obDup').onclick = () => { const o = cur0(), n = normObj({ ...JSON.parse(JSON.stringify({ ...o, _mesh: undefined, mesh: undefined })), mesh: o.mesh.gen ? { gen: o.mesh.gen } : { v: meshOf(o).v.slice(), f: meshOf(o).f.slice() } }); n.name = o.name + ' 복사'; n.pos = n.pos.map((v, d) => v + (d === 1 ? S.snap.step * 2 : 0)); n.kin.pivot = n.kin.pivot.map((v, d) => v + (d === 1 ? S.snap.step * 2 : 0)); S.objects.push(n); sel = S.objects.length - 1; rebuildScene(); renderObjList(); renderObjEditor(); };
  $('obDel').onclick = deleteSel;
  $('kinMode').onchange = () => { const k = cur0().kin; k.mode = $('kinMode').value; if (k.mode === 'hinge' && !k.advanced.enabled) k.spring = k.spring || 'mid'; renderObjEditor(); renderObjList(); updateObjView(sel); updateParams(); };
  $('kinAxis').onchange = () => { const k = cur0().kin, v = $('kinAxis').value; k.axisSel = v; if (v !== 'custom') k.axis = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[v]; renderObjEditor(); updateObjView(sel); updateParams(); };
  for (const [id, d] of [['axX', 0], ['axY', 1], ['axZ', 2]]) $(id).onchange = () => { cur0().kin.axis[d] = +$(id).value; updateObjView(sel); updateParams(); };
  for (const [id, d] of [['pvX', 0], ['pvY', 1], ['pvZ', 2]]) $(id).onchange = () => { cur0().kin.pivot[d] = +$(id).value; updateObjView(sel); updateParams(); };
  $('kinI').onchange = () => { cur0().kin.inertia = $('kinI').value; }; $('kinK').onchange = () => { cur0().kin.spring = $('kinK').value; };
  $('kinC').onchange = () => { cur0().kin.damping = $('kinC').value; };
  $('kinRpm').oninput = () => { cur0().kin.rpm = +$('kinRpm').value; updateParams(); }; $('kinDir').onchange = () => { cur0().kin.dir = $('kinDir').value; };
  const adv = () => { const a = cur0().kin.advanced; a.enabled = $('advOn').checked; a.I = $('advI').value; a.c = $('advC').value; a.k = $('advK').value; a.min = +$('advMin').value; a.max = +$('advMax').value; };
  for (const id of ['advOn', 'advI', 'advC', 'advK', 'advMin', 'advMax']) $(id).onchange = adv;
  $('btnPivot').onclick = () => { const on = !$('btnPivot').classList.contains('on'); $('btnPivot').classList.toggle('on', on); view.pickAnchor = on; hint(on ? '선택 객체의 앵커(흰색: 꼭짓점, 파랑: 면 중심)를 클릭하세요' : ''); };
}

function hint(t) { $('modeHint').textContent = t; $('modeHint').classList.toggle('hidden', !t); }
const cur0 = () => S.objects[sel];

function movePivot(o, oldCenter) {
  if (!o.kin.pivot) return;
  const c = centerOf(o);
  o.kin.pivot = o.kin.pivot.map((v, d) => v + c[d] - oldCenter[d]);
}

function deleteSel() {
  if (sel < 0) return;
  S.objects.splice(sel, 1); sel = -1; rebuildScene(); renderObjList(); renderObjEditor(); updateParams();
}

function snapPos(i, prop, axes) {
  const o = S.objects[i];
  if (!S.snap.on) return prop;
  const test = { ...o, pos: prop }, A = anchors(objectVerts(test)), s = S.snap.step;
  let best = null, bd = Infinity, bk = -1;
  A.forEach((p, k) => {
    const d = p.map((v, q) => (axes[q] ? Math.round((v - S.origin[q]) / s) * s + S.origin[q] - v : 0)), m = Math.hypot(...d);
    if (m < bd) { bd = m; best = d; bk = k; }
  });
  view.snapAnchor = bk;
  return prop.map((v, q) => Math.round((v + best[q]) * 1000) / 1000);
}

function addObject(o) {
  const n = normObj(o);
  S.objects.push(n); sel = S.objects.length - 1;
  rebuildScene(); renderObjList(); renderObjEditor(); updateParams();
  return n;
}

function addSample(kind) {
  const g = g3(), D = Math.min(g.Lx, g.Ly, g.Lz), O = S.origin, c = [g.Lx * 0.3, g.Ly / 2, g.Lz / 2].map((v, d) => Math.round(v / 10) * 10 + O[d]);
  if (kind === 'sphere') addObject({ name: `구 ${S.objects.length + 1}`, mesh: { gen: { type: 'sphere', r: Math.round(D * 0.1), seg: 24 } }, pos: c });
  if (kind === 'box') addObject({ name: `상자 ${S.objects.length + 1}`, mesh: { gen: { type: 'box', a: Math.round(D * 0.2), b: Math.round(D * 0.2), c: Math.round(D * 0.2) } }, pos: [c[0], c[1], O[2] + Math.round(D * 0.1)] });
  if (kind === 'plate') addObject({ name: `판 ${S.objects.length + 1}`, mesh: { gen: { type: 'box', a: Math.round(D * 0.02), b: Math.round(D * 0.4), c: Math.round(D * 0.3) } }, pos: c, voxel: 'both' });
  if (kind === 'rotor') {
    const R = Math.round(D * 0.28);
    const o = addObject({ name: `로터 ${S.objects.length + 1}`, mesh: { gen: { type: 'rotor', R, blades: 3, pitch: 30 } }, pos: c, voxel: 'both', kin: { mode: 'free', axis: [1, 0, 0], axisSel: 'x', pivot: c.slice(), inertia: 'low', damping: 'low' } });
    o.kin.pivot = c.slice(); updateObjView(sel); renderObjEditor(); renderObjList();
  }
}

async function importMeshes(files) {
  const sc = unitScale($('inUnit').value);
  for (const f of files) {
    try {
      const name = f.name.replace(/\.[^.]+$/, ''), ext = f.name.split('.').pop().toLowerCase();
      const cellmm = $('chkSimplify').checked ? g3().dxmm / 2 : 0;
      toast(`${f.name} 읽는 중… (${(f.size / 2 ** 20).toFixed(0)} MB)`, 60000);
      await new Promise((r) => setTimeout(r, 30));
      const m = ext === 'obj' ? parseOBJ(await f.text(), cellmm / sc) : parseSTL(await f.arrayBuffer(), cellmm / sc);
      if (sc !== 1) for (let i = 0; i < m.v.length; i++) m.v[i] *= sc;
      const simp = m.simplified ? m.simplified * sc : 0, raw = m.rawTris;
      const o = addObject({ name, mesh: { v: m.v, f: m.f }, pos: [0, 0, 0], ...(simp ? { voxel: 'both', simplified: simp } : {}) });
      const [a, b] = bbox(m.v), g = g3();
      const out = a.some((v, d) => v < 0 || b[d] > [g.Lx, g.Ly, g.Lz][d]);
      const info = simp ? `삼각형 ${raw.toLocaleString()} → ${(m.f.length / 3).toLocaleString()}개로 단순화 (${fmt(simp)} mm 격자, 솔리드+쉘 복셀화)` : `삼각형 ${(m.f.length / 3).toLocaleString()}개 · ${isClosed(m) ? '닫힌 메쉬' : '열린 메쉬(쉘로 처리)'}`;
      toast(`${f.name}: ${info}${out ? ' · 도메인 밖 부분은 해석에서 제외됩니다' : ''}`, 7000);
      o.kin.pivot = centerOf(o);
    } catch (e) { toast(`${f.name}: ${e.message}`, 5000); }
  }
}

function renderPatches() {
  const ul = $('patchList');
  ul.innerHTML = '';
  $('patchCount').textContent = S.patches.length ? `${S.patches.length}개` : '';
  S.patches.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = i === patchSel ? 'on' : '';
    const v = p.type === 'velocity' ? `${p.un} m/s` : p.type === 'pressure' ? `${p.p} Pa` : '';
    li.innerHTML = `<span class="sw" style="background:${FACE_COL[p.type]}"></span><span>${FACE_KO[p.face]} · ${{ rect: '사각형', circle: '원', poly: '폴리곤' }[p.shape]}</span><span class="tag">${{ velocity: '유입', pressure: '압력', outflow: '유출' }[p.type]}</span><span class="meta">${v}</span>`;
    li.onclick = () => { patchSel = i; renderPatches(); changed(false); };
    ul.appendChild(li);
  });
  const p = S.patches[patchSel];
  $('patchEditor').classList.toggle('hidden', !p);
  if (!p) return;
  const fs = $('paFace');
  if (!fs.options.length) for (const k of FACES) fs.add(new Option(FACE_KO[k], k));
  fs.value = p.face; $('paType').value = p.type;
  $('paValWrap').classList.toggle('hidden', p.type === 'outflow');
  $('paValWrap').firstChild.textContent = p.type === 'velocity' ? '속도 m/s' : '압력 Pa';
  $('paVal').value = p.type === 'velocity' ? p.un : p.p;
  $('paCu').value = p.cu; $('paCv').value = p.cv; $('paA').value = p.a ?? ''; $('paB').value = p.b ?? ''; $('paR').value = p.r ?? '';
  $('paA').parentElement.classList.toggle('hidden', p.shape !== 'rect'); $('paB').parentElement.classList.toggle('hidden', p.shape !== 'rect');
  $('paR').parentElement.classList.toggle('hidden', p.shape !== 'circle');
  $('paCu').parentElement.classList.toggle('hidden', p.shape === 'poly'); $('paCv').parentElement.classList.toggle('hidden', p.shape === 'poly');
}

function faceUV(face) {
  const g = g3(), L = [g.Lx, g.Ly, g.Lz], a = Math.floor(FACES.indexOf(face) / 2), ua = a === 0 ? 1 : 0, va = a === 2 ? 1 : 2;
  return [L[ua], L[va]];
}

function bindPatches() {
  const add = (shape) => {
    const face = 'xmin', [U, V] = faceUV(face);
    const p = { face, shape, cu: Math.round(U / 2), cv: Math.round(V / 2), type: 'velocity', un: 1, p: 0 };
    if (shape === 'rect') { p.a = Math.round(U / 4); p.b = Math.round(V / 4); } else p.r = Math.round(Math.min(U, V) / 8);
    S.patches.push(p); patchSel = S.patches.length - 1; renderPatches(); changed(false);
  };
  $('btnAddPatch').onclick = () => add('rect');
  $('btnAddCircle').onclick = () => add('circle');
  const upd = () => {
    const p = S.patches[patchSel];
    if (!p) return;
    p.face = $('paFace').value; p.type = $('paType').value;
    if (p.type === 'velocity') p.un = +$('paVal').value; else if (p.type === 'pressure') p.p = +$('paVal').value;
    p.cu = +$('paCu').value; p.cv = +$('paCv').value;
    if (p.shape === 'rect') { p.a = +$('paA').value; p.b = +$('paB').value; } else if (p.shape === 'circle') p.r = +$('paR').value;
    renderPatches(); changed(false);
  };
  for (const id of ['paFace', 'paType', 'paVal', 'paCu', 'paCv', 'paA', 'paB', 'paR']) $(id).onchange = upd;
  $('paDel').onclick = () => { S.patches.splice(patchSel, 1); patchSel = -1; renderPatches(); changed(false); };
  $('filePatchDxf').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const curves = parseDxf(await f.text()).filter((c) => c.closed && c.points.length >= 3);
      if (!curves.length) throw new Error('닫힌 곡선이 없습니다.');
      const face = S.patches[patchSel]?.face || 'xmin';
      for (const c of curves) S.patches.push({ face, shape: 'poly', pts: c.points.map(([x, y]) => [x, y]), type: 'velocity', un: 1, p: 0, cu: 0, cv: 0 });
      patchSel = S.patches.length - 1; renderPatches(); changed(false);
      toast(`${curves.length}개 닫힌 곡선을 ${FACE_KO[face]} 면 구간으로 추가했습니다. DXF의 (x, y)가 면 좌표 (u, v)로 들어갑니다.`, 5000);
    } catch (err) { toast(`DXF: ${err.message}`, 5000); }
  };
}

function setMode(m) {
  S.mode = m;
  document.querySelectorAll('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.view === m));
  view.setMode(m);
  view.setObjectsTranslucent(m === 'result' && $('chkSolidHide').checked);
  $('legend').classList.toggle('hidden', m !== 'result' || !frames.length);
  $('play').classList.toggle('hidden', m !== 'result' || !frames.length);
  hint('');
  if (m === 'result') refreshResult();
}

function sliceIdx() {
  const g = g3(), N = [g.Nx, g.Ny, g.Nz];
  return 'XYZ'.split('').map((P, d) => clamp(Math.round(S.view.slices[P].f * N[d] - 0.5), 0, N[d] - 1));
}

function updateSliceText() {
  const g = g3(), idx = sliceIdx();
  'XYZ'.split('').forEach((P, d) => { $(`sl${P}t`).textContent = `${mm((idx[d] + 0.5) * g.dxmm + S.origin[d])}`; });
}

function frameView(f) {
  if (!f || !$('chkMean').checked || !f.mean) return f;
  return { ...f, X: f.mean.X, Y: f.mean.Y, Z: f.mean.Z };
}

function refreshResult() {
  if (!view || S.mode !== 'result') return;
  const fr = frameView(frames[cur]);
  if (!fr || !run) { view.setSliceMeshes([]); view.setLines('vectors', null); view.setLines('streams', null); view.setParticles(null); return; }
  const prm = run.prm, v = S.view, field = v.field, rho = +S.fluid.rho;
  const planes = 'XYZ'.split('').filter((P) => v.slices[P].on);
  const pfs = planes.map((P) => planeField(fr, P, field, prm, rho));
  let lo, hi;
  if (v.range === 'run' && runRange && runRange.field === field) [lo, hi] = runRange.r;
  else if (pfs.length) [lo, hi] = fieldRange(field, pfs); else [lo, hi] = [0, 1];
  const light = document.documentElement.dataset.theme === 'light', solidRGB = light ? [150, 155, 165] : [70, 74, 84];
  view.setSliceMeshes(pfs.map((pf, q) => ({ w: pf.w, h: pf.h, rgba: toRGBA(pf, field, lo, hi, solidRGB), quad: planeQuad(planes[q], fr.idx['XYZ'.indexOf(planes[q])], prm) })));
  const vc = light ? 0x111827 : 0xf2f5fa;
  if ($('chkVec').checked) { const segs = []; for (const P of planes) segs.push(...planeVectors(fr, P, prm, Math.max(1, +v.stride))); view.setLines('vectors', segs, vc, 0.9); } else view.setLines('vectors', null);
  if ($('chkStream').checked && v.slices[v.streamPlane].on) view.setLines('streams', planeStreams(fr, v.streamPlane, prm, +$('inSdens').value), light ? 0x0f172a : 0xffffff, 0.85); else view.setLines('streams', null);
  if ($('chkPart').checked) { const [pos, col] = particleBuffers(fr, prm, (S.u_lat_max || 0.06) * 1.1); view.setParticles(pos, col, +v.psize); } else view.setParticles(null);
  const ang = new Map();
  run.kinIdx.forEach((oi, b) => { if (fr.bodies[b]) ang.set(oi, fr.bodies[b][0]); });
  view.setBodyAngles(ang);
  $('legend').classList.remove('hidden');
  $('lgName').textContent = FIELD_LABEL[field];
  legendCanvas($('legendCv'), field);
  $('lgLo').textContent = fmt(lo); $('lgHi').textContent = fmt(hi);
  $('playText').textContent = `${(fr.step * prm.dt).toFixed(2)} s · ${cur + 1}/${frames.length}`;
  $('playSlider').max = Math.max(0, frames.length - 1); $('playSlider').value = cur;
}

function computeRunRange() {
  if (!frames.length || !run) return;
  const field = S.view.field, planes = 'XYZ'.split('').filter((P) => S.view.slices[P].on), pick = [];
  for (let i = Math.floor(frames.length / 2); i < frames.length; i += Math.max(1, Math.floor(frames.length / 12))) for (const P of planes) pick.push(planeField(frames[i], P, field, run.prm, +S.fluid.rho));
  runRange = { field, r: pick.length ? fieldRange(field, pick) : [0, 1] };
}

function setState(st) {
  state = st;
  const b = $('stateBadge'); b.className = `badge ${st}`; b.textContent = STATE_KO[st] || st;
  const busy = locked();
  $('btnRun').disabled = busy; $('btnStop').disabled = !busy; $('btnPause').disabled = !['running', 'paused'].includes(st);
  $('btnPause').textContent = st === 'paused' ? '계속' : '일시정지';
  $('btnGif').disabled = frames.length < 2;
  updateParams();
}

function startRun() {
  if (locked()) return;
  const c = caseForSolver();
  frames = []; cur = -1; runRange = null;
  run = { prm: null, kinIdx: S.objects.map((o, i) => (o.role === 'solid' && o.kin.mode !== 'off' ? i : -1)).filter((i) => i >= 0), names: S.objects.map((o) => o.name), kin: S.objects.map((o) => o.role === 'solid' && o.kin.mode !== 'off'), axis: S.objects.map((o) => o.kin.axis), rho: +S.fluid.rho };
  setState('building');
  setMode('result');
  worker.postMessage({ cmd: 'run', case: c, opts: { backend: S.backend, frames: S.frames, particles: S.particles, slices: sliceIdx(), probes: probeIdx() } });
  run.probes = S.probes.map((p) => p.slice());
}

function onWorker(ev) {
  const m = ev.data;
  if (m.type === 'state') { setState(m.state); if (m.state === 'diverged') toast('계산이 발산했습니다. u_lat,max를 낮추거나 격자를 키워 보세요.', 6000); if (['done', 'stopped'].includes(m.state)) { computeRunRange(); renderLoads(); drawLoadChart(); drawProbeChart(); } }
  else if (m.type === 'started') {
    run.prm = { ...m.prm, Nx: m.prm.Nx, Ny: m.prm.Ny, Nz: m.prm.Nz }; run.backend = m.backend; run.steps = m.steps;
    $('devName').textContent = m.backend === 'gpu' ? `GPU · ${gpuInfo?.name || 'WebGPU'}` : 'CPU (JS)';
    for (const id of ['btnS3', 'btnQ', 'btnVtk']) $(id).disabled = false;
  } else if (m.type === 'frame') {
    frames.push(m.frame);
    const follow = cur === frames.length - 2 || cur < 0;
    if (follow) { cur = frames.length - 1; refreshResult(); }
    $('play').classList.toggle('hidden', S.mode !== 'result');
    $('btnGif').disabled = frames.length < 2;
    if (frames.length % 3 === 0 || state !== 'running') { renderLoads(); drawLoadChart(); drawProbeChart(); }
  } else if (m.type === 'reslice') {
    if (frames.length) { frames[frames.length - 1] = { ...m.frame, parts: frames[frames.length - 1].parts }; if (cur === frames.length - 1) refreshResult(); }
  } else if (m.type === 'progress') {
    const p = m.step / m.steps;
    $('progBar').style.width = `${(100 * p).toFixed(1)}%`;
    const eta = m.sps ? (m.steps - m.step) / m.sps : 0;
    $('progText').textContent = `${(m.step * (run?.prm?.dt || 0)).toFixed(2)} s · ${m.step.toLocaleString()}/${m.steps.toLocaleString()} · ${m.mlups ? `${fmt(m.mlups, 0)} MLUPS` : `${fmt(m.sps, 0)} 스텝/s`} · 남은 ${eta < 90 ? Math.round(eta) + ' s' : (eta / 60).toFixed(1) + ' 분'}`;
    $('progText').title = `${fmt(m.sps, 0)} 스텝/s`;
  } else if (m.type === 'busy') { $('anInfo').textContent = m.msg; }
  else if (m.type === 'stream3d') {
    const o = run.prm.dxmm, L = lutOf('umag'), pos = new Float32Array(m.pos.length), col = new Float32Array(m.pos.length);
    for (let i = 0; i < m.pos.length; i++) pos[i] = m.pos[i] * o;
    for (let i = 0; i < m.spd.length; i++) { const c = L[Math.min(L.length - 1, Math.round(m.spd[i] / (m.umax || 1) * (L.length - 1)))]; col.set([c[0] / 255, c[1] / 255, c[2] / 255], 3 * i); }
    view.setColoredLines('stream3d', pos, col);
    $('anInfo').textContent = `3D 유선 ${m.lines}개 (유입면 시드, 색 = 속도)`;
  } else if (m.type === 'qiso') {
    const o = run.prm.dxmm, L = lutOf('umag'), pos = new Float32Array(m.pos.length), col = new Float32Array(m.pos.length);
    let um = 0;
    for (const v of m.spd) um = Math.max(um, v);
    for (let i = 0; i < m.pos.length; i++) pos[i] = m.pos[i] * o;
    for (let i = 0; i < m.spd.length; i++) { const c = L[Math.min(L.length - 1, Math.round(m.spd[i] / (um || 1) * (L.length - 1)))]; col.set([c[0] / 255, c[1] / 255, c[2] / 255], 3 * i); }
    view.setIso(pos, col);
    $('anInfo').textContent = `Q 등치면: Q = ${fmt(m.level)} 1/s² · 삼각형 ${m.tris.toLocaleString()}개 (색 = 속도)`;
  } else if (m.type === 'vtk') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([m.buf], { type: 'application/octet-stream' })); a.download = `${S.name || 'lbm3d'}${m.mean ? '_mean' : ''}.vtk`; a.click();
    $('anInfo').textContent = `VTK 저장 완료 (${(m.buf.byteLength / 2 ** 20).toFixed(1)} MB, 단위 m·m/s·Pa, ParaView에서 열기)`;
  } else if (m.type === 'error') toast(`오류: ${m.msg}`, 7000);
  else if (m.type === 'log') toast(m.msg, 6000);
  else if (m.type === 'probe') {
    gpuInfo = m.gpu;
    $('devName').textContent = gpuInfo ? `GPU 사용 가능 · ${gpuInfo.name}` : 'WebGPU 없음 → CPU 계산';
    updateParams();
  } else if (m.type === 'voxels') {
    voxCells = { cells: m.cells, dxmm: m.dxmm };
    $('chkVox').checked = true; showVoxels();
    toast(`표면 복셀 ${(m.cells.length / 4).toLocaleString()}개 표시`);
  }
}

function showVoxels() {
  if (!voxCells) return;
  const pal = (id) => (id >= 1000 ? 0x4f8cff : parseInt(OBJ_HEX[id % OBJ_HEX.length].slice(1), 16));
  const n = voxCells.cells.length / 4;
  if (n > 400000) { toast('복셀이 너무 많아 일부만 표시합니다.'); view.setVoxels(voxCells.cells.subarray(0, 4 * 400000), voxCells.dxmm, pal); return; }
  view.setVoxels(voxCells.cells, voxCells.dxmm, pal);
}

function probeIdx() {
  const g = g3();
  return S.probes.map((p) => {
    const i = clamp(Math.floor((p[0] - S.origin[0]) / g.dxmm), 0, g.Nx - 1), j = clamp(Math.floor((p[1] - S.origin[1]) / g.dxmm), 0, g.Ny - 1), k = clamp(Math.floor((p[2] - S.origin[2]) / g.dxmm), 0, g.Nz - 1);
    return i + g.Nx * (j + g.Ny * k);
  });
}

function renderProbes() {
  const ul = $('probeList');
  ul.innerHTML = '';
  S.probes.forEach((p, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="sw" style="background:#${PROBE_COLORS[i % PROBE_COLORS.length].toString(16).padStart(6, '0')}"></span><span>P${i + 1}</span><span class="meta">(${p.map(mm).join(', ')}) mm</span><button class="ghost small">×</button>`;
    li.querySelector('button').onclick = (e) => { e.stopPropagation(); S.probes.splice(i, 1); probesChanged(); };
    ul.appendChild(li);
  });
  view.setProbes(S.probes, g3().dxmm);
}

function probesChanged() {
  renderProbes(); drawProbeChart();
  if (S.probes.length > 64) S.probes.length = 64;
  worker.postMessage({ cmd: 'probes', idx: probeIdx() });
  if (run) run.probes = S.probes.map((p) => p.slice());
}

function drawProbeChart() {
  const c = $('probeChart'), r = c.getBoundingClientRect(), w = Math.max(200, Math.round(r.width || 336)), h = 140, d = window.devicePixelRatio || 1;
  c.width = w * d; c.height = h * d;
  const g = c.getContext('2d'), cs = getComputedStyle(document.documentElement);
  g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, w, h);
  g.font = '10px system-ui'; g.fillStyle = cs.getPropertyValue('--muted');
  const fs = frames.filter((f) => f.probes && f.probes.length);
  if (!run || !run.prm || fs.length < 2 || !S.probes.length) { g.fillText('프로브를 추가하면 해석 중/후 시계열이 표시됩니다.', 8, h / 2); return; }
  const qty = $('prQty').value, vs = run.prm.dx / run.prm.dt, ps = +S.fluid.rho * vs * vs / 3, useM = $('chkMean').checked;
  const val = (f, i) => { const a = useM && f.probesMean ? f.probesMean : f.probes; if (4 * i + 3 >= a.length) return NaN; const u = [a[4 * i], a[4 * i + 1], a[4 * i + 2]], rr = a[4 * i + 3]; if (!rr) return NaN; return qty === 'umag' ? Math.hypot(...u) * vs : qty === 'p' ? (rr - 1) * ps : u[{ ux: 0, uy: 1, uz: 2 }[qty]] * vs; };
  const ts = fs.map((f) => f.step * run.prm.dt), n = Math.min(S.probes.length, fs[fs.length - 1].probes.length / 4);
  const series = [];
  for (let i = 0; i < n; i++) series.push(fs.map((f) => val(f, i)));
  const all = series.flat().filter(Number.isFinite);
  if (!all.length) { g.fillText('프로브 위치가 고체 안에 있습니다.', 8, h / 2); return; }
  let y0 = Math.min(...all), y1 = Math.max(...all);
  if (y1 - y0 < 1e-12) { y0 -= 1; y1 += 1; }
  const pad = 34, X = (t) => pad + (t - ts[0]) / Math.max(ts.at(-1) - ts[0], 1e-9) * (w - pad - 8), Y = (v) => 8 + (1 - (v - y0) / (y1 - y0)) * (h - 26);
  g.strokeStyle = cs.getPropertyValue('--cv-grid-major'); g.lineWidth = 1;
  g.beginPath(); g.moveTo(pad, 8); g.lineTo(pad, h - 18); g.lineTo(w - 8, h - 18); g.stroke();
  g.fillText(fmt(y1), 2, 14); g.fillText(fmt(y0), 2, h - 20);
  g.fillText(`${ts[0].toFixed(1)} s`, pad, h - 5); g.textAlign = 'right'; g.fillText(`${ts.at(-1).toFixed(1)} s`, w - 8, h - 5); g.textAlign = 'left';
  series.forEach((ys, i) => {
    g.strokeStyle = '#' + PROBE_COLORS[i % PROBE_COLORS.length].toString(16).padStart(6, '0'); g.lineWidth = 1.5; g.beginPath();
    let on = false;
    ys.forEach((v, k) => { if (!Number.isFinite(v)) { on = false; return; } const x = X(ts[k]), y = Y(v); on ? g.lineTo(x, y) : g.moveTo(x, y); on = true; });
    g.stroke();
  });
}

function physLoads(fr) {
  const prm = run.prm, rho = run.rho, F = rho * prm.dx ** 4 / prm.dt ** 2, M = rho * prm.dx ** 5 / prm.dt ** 2;
  return run.names.map((_, i) => {
    const L = fr.loads.slice(6 * i, 6 * i + 6);
    const a = run.axis[i] || [1, 0, 0], n = Math.hypot(...a) || 1;
    const b = run.kinIdx.indexOf(i), body = b >= 0 ? fr.bodies[b] : null;
    return {
      fx: L[0] * F, fy: L[1] * F, fz: L[2] * F,
      ma: run.kin[i] ? (L[3] * a[0] + L[4] * a[1] + L[5] * a[2]) / n * M : Math.hypot(L[3], L[4], L[5]) * M,
      theta: body ? body[0] * 180 / Math.PI : NaN, rpm: body ? body[1] / prm.dt * 60 / (2 * Math.PI) : NaN,
    };
  });
}

function renderLoads() {
  const t = $('loadTable'), sel0 = $('loadObj').value;
  if (!run || !run.prm || !frames.length) { t.innerHTML = '<tr><td class="hint">해석을 실행하면 객체별 하중이 표시됩니다.</td></tr>'; $('loadObj').innerHTML = ''; return; }
  const half = frames.slice(Math.floor(frames.length / 2)), all = half.map(physLoads), n = run.names.length;
  const mean = (i, k) => all.reduce((s, r) => s + r[i][k], 0) / all.length;
  let h = '<tr><th>객체</th><th>F<sub>x</sub> N</th><th>F<sub>y</sub> N</th><th>F<sub>z</sub> N</th><th>M N·m</th><th>θ °</th><th>rpm</th></tr>';
  for (let i = 0; i < n; i++) h += `<tr><td title="${run.names[i]}">${run.names[i]}</td>${['fx', 'fy', 'fz', 'ma', 'theta', 'rpm'].map((k) => `<td>${fmt(mean(i, k))}</td>`).join('')}</tr>`;
  t.innerHTML = h;
  const so = $('loadObj');
  if (so.options.length !== n) { so.innerHTML = ''; run.names.forEach((nm, i) => so.add(new Option(nm, i))); so.value = sel0 && +sel0 < n ? sel0 : (run.kinIdx[0] ?? 0); }
}

function drawLoadChart() {
  const c = $('loadChart'), r = c.getBoundingClientRect(), w = Math.max(200, Math.round(r.width || 336)), h = 140, d = window.devicePixelRatio || 1;
  c.width = w * d; c.height = h * d;
  const g = c.getContext('2d'), cs = getComputedStyle(document.documentElement);
  g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, w, h);
  g.font = '10px system-ui'; g.fillStyle = cs.getPropertyValue('--muted');
  if (!run || !run.prm || frames.length < 2) { g.fillText('해석 중/후 선택한 객체의 시계열이 표시됩니다.', 8, h / 2); return; }
  const i = +$('loadObj').value || 0, qty = $('loadQty').value;
  const ts = frames.map((f) => f.step * run.prm.dt), ys = frames.map((f) => physLoads(f)[i][qty]);
  if (!ys.every(Number.isFinite)) { g.fillText('이 객체는 움직이지 않아 해당 항목이 없습니다.', 8, h / 2); return; }
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y1 - y0 < 1e-12) { y0 -= 1; y1 += 1; }
  const pad = 34, X = (t) => pad + (t - ts[0]) / Math.max(ts.at(-1) - ts[0], 1e-9) * (w - pad - 8), Y = (v) => 8 + (1 - (v - y0) / (y1 - y0)) * (h - 26);
  g.strokeStyle = cs.getPropertyValue('--cv-grid-major'); g.lineWidth = 1;
  g.beginPath(); g.moveTo(pad, 8); g.lineTo(pad, h - 18); g.lineTo(w - 8, h - 18); g.stroke();
  if (y0 < 0 && y1 > 0) { g.setLineDash([3, 3]); g.beginPath(); g.moveTo(pad, Y(0)); g.lineTo(w - 8, Y(0)); g.stroke(); g.setLineDash([]); }
  g.fillText(fmt(y1), 2, 14); g.fillText(fmt(y0), 2, h - 20);
  g.fillText(`${ts[0].toFixed(1)} s`, pad, h - 5); g.textAlign = 'right'; g.fillText(`${ts.at(-1).toFixed(1)} s`, w - 8, h - 5); g.textAlign = 'left';
  g.strokeStyle = cs.getPropertyValue('--accent'); g.lineWidth = 1.5; g.beginPath();
  ys.forEach((v, k) => { const x = X(ts[k]), y = Y(v); k ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.stroke();
  if (cur >= 0 && cur < ts.length) { g.fillStyle = cs.getPropertyValue('--accent'); g.beginPath(); g.arc(X(ts[cur]), Y(ys[cur]), 3, 0, 7); g.fill(); }
}

async function makeGif() {
  if (frames.length < 2) return;
  const btn = $('btnGif'), was = cur;
  btn.disabled = true;
  const src = view.canvas(), W = clamp(+$('inGifW').value || 640, 240, 1280), H = Math.round(W * src.height / src.width / 2) * 2;
  const off = document.createElement('canvas'); off.width = W; off.height = H;
  const g = off.getContext('2d', { willReadFrequently: true }), gif = GIFEncoder(), delay = Math.max(20, Math.round(1000 / clamp(+$('inFps').value || 15, 1, 50)));
  const step = Math.max(1, Math.ceil(frames.length / 150));
  let pal = null;
  for (let i = 0; i < frames.length; i += step) {
    cur = i; refreshResult(); view.renderNow();
    g.drawImage(src, 0, 0, W, H);
    g.font = '600 13px system-ui'; g.fillStyle = document.documentElement.dataset.theme === 'light' ? '#111' : '#fff';
    g.fillText(`t = ${(frames[i].step * run.prm.dt).toFixed(2)} s   ${FIELD_LABEL[S.view.field]}`, 10, 20);
    const data = g.getImageData(0, 0, W, H).data;
    if (!pal) pal = quantize(data, 256);
    gif.writeFrame(applyPalette(data, pal), W, H, i === 0 ? { palette: pal, delay, repeat: 0 } : { delay });
    btn.textContent = `GIF 만드는 중… ${Math.round(100 * i / frames.length)}%`;
    await new Promise((r) => setTimeout(r, 0));
  }
  gif.finish();
  const url = URL.createObjectURL(new Blob([gif.bytes()], { type: 'image/gif' }));
  $('gifImg').src = url; $('gifLink').href = url; $('gifLink').download = `${S.name || 'lbm3d'}.gif`; $('gifBox').classList.remove('hidden');
  btn.textContent = 'GIF 만들기 (현재 시점)'; btn.disabled = false;
  cur = was; refreshResult();
}

function bindAnalysis() {
  const go = (kind) => { $('anInfo').textContent = '계산 중…'; worker.postMessage({ cmd: 'analyze', kind, mean: $('chkAnMean').checked, count: Math.round(30 * 1.45 ** +$('inSdens').value), frac: +$('inQf').value / 100 }); if (S.mode !== 'result') setMode('result'); };
  $('btnS3').onclick = () => go('stream');
  $('btnQ').onclick = () => go('qiso');
  $('btnVtk').onclick = () => go('vtk');
  $('btnAnClear').onclick = () => { view.setColoredLines('stream3d', null); view.setIso(null); $('anInfo').textContent = ''; };
  $('chkMean').onchange = () => { refreshResult(); drawProbeChart(); };
  $('prQty').onchange = drawProbeChart;
  $('btnPrAdd').onclick = () => { const p = [+$('prX').value, +$('prY').value, +$('prZ').value]; if (p.some((v) => !Number.isFinite(v))) return; S.probes.push(p); probesChanged(); };
  $('btnPrClear').onclick = () => { S.probes = []; probesChanged(); };
  $('btnPrPick').onclick = () => { const on = !$('btnPrPick').classList.contains('on'); $('btnPrPick').classList.toggle('on', on); view.pickProbe = on; if (on && S.mode !== 'result') setMode('result'); hint(on ? '결과 단면을 클릭하면 그 점에 프로브가 추가됩니다 (Esc로 종료)' : ''); };
}

function bindView() {
  document.querySelectorAll('#viewSeg button').forEach((b) => { b.onclick = () => setMode(b.dataset.view); });
  document.querySelectorAll('#camSeg button').forEach((b) => { b.onclick = () => view.camPreset(b.dataset.cam); });
  $('btnFit').onclick = () => view.camPreset('iso');
  $('chkGrid').onchange = () => { view.groups.grid.visible = $('chkGrid').checked; };
  $('chkBC').onchange = () => changed(false);
  $('chkVox').onchange = () => { if ($('chkVox').checked) { if (!voxCells) requestVoxels(); else showVoxels(); } else view.setVoxels(null); };
  for (const id of ['chkVec', 'chkStream', 'chkPart']) $(id).onchange = refreshResult;
  $('chkSolidHide').onchange = () => view.setObjectsTranslucent(S.mode === 'result' && $('chkSolidHide').checked);
  $('inField').onchange = () => { S.view.field = $('inField').value; runRange = null; if (S.view.range === 'run') computeRunRange(); refreshResult(); };
  $('inRange').onchange = () => { S.view.range = $('inRange').value; if (S.view.range === 'run') computeRunRange(); refreshResult(); };
  $('inStride').onchange = () => { S.view.stride = +$('inStride').value; refreshResult(); };
  $('inStreamPlane').onchange = () => { S.view.streamPlane = $('inStreamPlane').value; refreshResult(); };
  $('inPsize').onchange = () => { S.view.psize = +$('inPsize').value; refreshResult(); };
  let slTimer = null;
  for (const P of 'XYZ') {
    $(`sl${P}`).onchange = () => { S.view.slices[P].on = $(`sl${P}`).checked; refreshResult(); scheduleGuides(); };
    $(`sl${P}v`).oninput = () => {
      S.view.slices[P].f = +$(`sl${P}v`).value / 1000; updateSliceText(); scheduleGuides();
      clearTimeout(slTimer);
      slTimer = setTimeout(() => worker.postMessage({ cmd: 'slices', idx: sliceIdx() }), 120);
    };
  }
  const densText = () => { const d = +$('inSdens').value; $('inSdensT').textContent = d <= 3 ? `${d} 낮음` : d <= 7 ? `${d} 중간` : `${d} 높음`; };
  densText();
  let densTimer = null;
  $('inSdens').oninput = () => {
    densText(); refreshResult();
    clearTimeout(densTimer);
    if (view.groups.stream3d.children.length) densTimer = setTimeout(() => $('btnS3').click(), 400);
  };
  $('playSlider').oninput = () => { cur = +$('playSlider').value; refreshResult(); drawLoadChart(); };
  $('btnPlay').onclick = () => {
    if (playing) { clearInterval(playing); playing = null; $('btnPlay').textContent = '▶'; return; }
    $('btnPlay').textContent = '❚❚';
    playing = setInterval(() => { if (!frames.length) return; cur = (cur + 1) % frames.length; refreshResult(); }, 1000 / clamp(+$('inFps').value || 15, 1, 50));
  };
  $('loadObj').onchange = drawLoadChart; $('loadQty').onchange = drawLoadChart;
  $('btnRun').onclick = startRun;
  $('btnStop').onclick = () => worker.postMessage({ cmd: 'stop' });
  $('btnPause').onclick = () => worker.postMessage({ cmd: 'pause', on: state !== 'paused' });
  $('btnVoxel').onclick = requestVoxels;
  $('btnGif').onclick = makeGif;
  $('btnAddSphere').onclick = () => addSample('sphere'); $('btnAddBox').onclick = () => addSample('box');
  $('btnAddRotor').onclick = () => addSample('rotor'); $('btnAddPlate').onclick = () => addSample('plate');
  $('fileMesh').onchange = async (e) => { await importMeshes([...e.target.files]); e.target.value = ''; };
  $('btnSaveCase').onclick = () => {
    const blob = new Blob([JSON.stringify(caseForSave())], { type: 'application/json' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${S.name || 'case3d'}.json`; a.click();
  };
  $('fileCase').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try { const c = JSON.parse(await f.text()); if (c.dim !== 3) throw new Error('3D 케이스 파일이 아닙니다. 2D 케이스는 2D 화면에서 불러와 주세요.'); loadCase(c); toast(`${f.name} 불러옴`); } catch (err) { toast(err.message, 5000); }
  };
  $('selExample').onchange = async () => {
    const v = $('selExample').value; $('selExample').value = '';
    if (!v) return;
    try { const c = await (await fetch(`samples/3d/${v}`)).json(); loadCase(c); toast(`예제: ${c.title || c.name}`); } catch (err) { toast(err.message); }
  };
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel >= 0 && S.mode === 'edit') deleteSel();
    if (e.key === 'Escape') { $('btnPivot').classList.remove('on'); view.pickAnchor = false; $('btnPrPick').classList.remove('on'); view.pickProbe = false; hint(''); }
  });
}

function requestVoxels() {
  toast('복셀 계산 중…');
  worker.postMessage({ cmd: 'voxels', case: caseForSolver() });
}

async function loadExamples() {
  try {
    const idx = await (await fetch('samples/3d/index.json')).json();
    for (const c of idx.cases) $('selExample').add(new Option(c.title, c.file));
  } catch (_) {}
}

function init() {
  try { theme = localStorage.getItem('lbm-theme') || 'system'; } catch (_) { theme = 'system'; }
  view = new View3D($('view3d'), {
    onSelect: (i) => selectObj(i),
    onDrag: (i, prop, axes) => {
      const o = S.objects[i], old = centerOf(o);
      o.pos = snapPos(i, prop, axes);
      movePivot(o, old);
      updateObjView(i);
      view.buildHelpers(view.snapAnchor);
      [$('obX').value, $('obY').value, $('obZ').value] = o.pos.map((v) => +v.toFixed(1));
      $('cursorInfo').textContent = `위치 (${o.pos.map(mm).join(', ')}) mm${S.snap.on ? ` · 스냅 ${S.snap.step} mm` : ''}`;
    },
    onDragEnd: () => { renderObjEditor(); updateParams(); voxCells = null; if ($('chkVox').checked) { $('chkVox').checked = false; view.setVoxels(null); } },
    onAnchor: (i, p) => {
      const o = S.objects[i];
      o.kin.pivot = p.map((v) => +v.toFixed(3));
      $('btnPivot').classList.remove('on'); view.pickAnchor = false; hint('');
      renderObjEditor(); updateObjView(i);
      toast(`회전축 위치: (${o.kin.pivot.map(mm).join(', ')}) mm`);
    },
    onProbe: (p) => { S.probes.push(p.map((v) => Math.round(v))); probesChanged(); toast(`프로브 P${S.probes.length} 추가: (${p.map(mm).join(', ')}) mm`); },
    onHover: (ev) => {
      if (S.mode !== 'result' || !frames[cur] || !run) return;
      const p = view.hitSlices(ev);
      if (!p) { $('cursorInfo').textContent = ''; return; }
      const arr = p.toArray(), planes = 'XYZ'.split('').filter((P) => S.view.slices[P].on);
      let best = null;
      for (const P of planes) { const d = 'XYZ'.indexOf(P), c = (frames[cur].idx[d] + 0.5) * run.prm.dxmm; if (Math.abs(arr[d] - c) < run.prm.dxmm) best = P; }
      if (!best) return;
      const v = sampleAt(frames[cur], best, run.prm, arr, S.view.field, +S.fluid.rho);
      $('cursorInfo').textContent = `(${arr.map((x, d) => mm(x + S.origin[d])).join(', ')}) mm · ${FIELD_LABEL[S.view.field]} = ${Number.isNaN(v) ? '고체' : fmt(v)}`;
    },
  });
  worker = new Worker('js/worker3d.js', { type: 'module' });
  worker.onmessage = onWorker;
  worker.onerror = (e) => toast(`워커 오류: ${e.message}`, 6000);
  worker.postMessage({ cmd: 'probe' });
  applyTheme();
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (theme === 'system') applyTheme(); });
  $('btnTheme').onclick = () => { theme = THEME_NEXT[theme]; try { localStorage.setItem('lbm-theme', theme); } catch (_) {} applyTheme(); };
  bindInputs(); bindPatches(); bindView(); bindAnalysis();
  loadExamples();
  fetch('samples/3d/turbine_free.json').then((r) => r.json()).then(loadCase).catch(() => { loadCase(defaultCase()); });
  window.__lbm3d = { get S() { return S; }, get frames() { return frames; }, get state() { return state; }, view, startRun, loadCase, setMode };
}

init();
