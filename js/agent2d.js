import { mountAgent, bindBottom } from './simweb/panel.js';
import { parse } from './agent/rules.js';
import { SYSTEM2 } from './agent/prompts.js';

const L = window.__lbm2d, S = L.S;
const EDGES = ['left', 'right', 'bottom', 'top'];
const TYPES = ['velocity', 'pressure', 'outflow', 'wall', 'slip'];
const $ = (id) => document.getElementById(id);
const num = (v, name) => { const x = +v; if (!Number.isFinite(x)) throw new Error(`${name} 값이 숫자가 아닙니다: ${v}`); return x; };
const KEEP = ['Lx', 'Ly', 'Nx', 'ox', 'oy', 'clip', 'preset', 'nu', 'rho', 'les', 'cs', 'duration', 'ramp', 'frames', 'ulat', 'sponge', 'edges', 'patches', 'objects', 'emitters', 'sel', 'field', 'showVec', 'showStream', 'showPart', 'showMask', 'showGrid'];

function snapshot() { return JSON.parse(JSON.stringify(Object.fromEntries(KEEP.map((k) => [k, S[k]])))); }
function restore(s) {
  Object.assign(S, JSON.parse(JSON.stringify(s)));
  S.objects.forEach(L.ensureObj);
  L.setUid(1 + Math.max(0, ...S.objects.map((o) => o.id), ...S.patches.map((p) => p.id)));
  refresh();
}
function refresh() {
  L.syncInputs(); L.renderEdgeRows(); L.renderObjList(); L.renderObjEditor(); L.renderPatchList(); L.renderPatchEditor();
  for (const [id, k] of [['chkVec', 'showVec'], ['chkStream', 'showStream'], ['chkPart', 'showPart'], ['chkMask', 'showMask'], ['chkGrid', 'showGrid']]) $(id).checked = !!S[k];
  $('inField').value = S.field;
  L.changed();
}

function targets(t) {
  const objs = S.objects;
  if (t === 'all') return objs.map((o) => o);
  if (t === 'selected' || t === 'last') { const o = L.selObj() || (objs.length === 1 ? objs[0] : null); if (!o) throw new Error('선택된 객체가 없습니다. 객체 번호나 이름을 알려 주세요.'); return [o]; }
  if (typeof t === 'number' || /^\d+$/.test(String(t))) { const o = objs[+t - 1]; if (!o) throw new Error(`${t}번 객체가 없습니다 (현재 ${objs.length}개)`); return [o]; }
  const o = objs.find((x) => x.name === t) || objs.find((x) => x.name.toLowerCase().includes(String(t).toLowerCase()));
  if (!o) throw new Error(`'${t}' 객체를 찾지 못했습니다. 있는 객체: ${objs.map((x) => x.name).join(', ') || '없음'}`);
  return [o];
}

function bc(target, o) {
  const type = o.type || target.type;
  if (!TYPES.includes(type)) throw new Error(`경계 종류가 잘못되었습니다: ${type}`);
  target.type = type;
  if (type === 'velocity') {
    if (Array.isArray(o.u)) [target.ux, target.uy] = o.u.map((v) => num(v, 'u'));
    else if (o.speed !== undefined) { const n = L.EDGE_NORMAL[o.edge]; target.ux = n[0] * Math.abs(num(o.speed, '속도')); target.uy = n[1] * Math.abs(num(o.speed, '속도')); }
  }
  if (type === 'pressure' && o.p !== undefined) target.p = num(o.p, '압력');
}

function apply(ops) {
  const log = [];
  if (L.locked() && ops.some((o) => !['set_view', 'plot', 'stop', 'run'].includes(o.op))) throw new Error('2D는 해석 중에 조건을 바꿀 수 없습니다. 먼저 중단해 주세요.');
  const F2E = { xmin: 'left', xmax: 'right', ymin: 'bottom', ymax: 'top' };
  for (const o of ops) {
    if (o.face && !o.edge && F2E[o.face]) { o.edge = F2E[o.face]; if (o.op === 'set_face') o.op = 'set_edge'; }
    switch (o.op) {
      case 'set_domain': {
        if (o.size) [S.Lx, S.Ly] = o.size.map((v) => num(v, '크기'));
        if (o.Lx !== undefined) S.Lx = num(o.Lx, 'Lx');
        if (o.Ly !== undefined) S.Ly = num(o.Ly, 'Ly');
        if (o.Nx !== undefined) S.Nx = Math.round(num(o.Nx, 'Nx'));
        if (o.cells_x !== undefined) S.Nx = Math.round(num(o.cells_x, 'Nx'));
        if (o.dx !== undefined) S.Nx = Math.round(S.Lx / num(o.dx, 'Δx'));
        if (o.refine) S.Nx = Math.round(S.Nx * num(o.refine, '배율'));
        if (o.origin) { const [nx, ny] = o.origin.map((v) => num(v, '원점')), dx = nx - (+S.ox || 0), dy = ny - (+S.oy || 0); for (const ob of S.objects) { ob.cx -= dx; ob.cy -= dy; } S.ox = nx; S.oy = ny; }
        S.Nx = Math.min(2000, Math.max(20, S.Nx));
        if (!(S.Lx > 0 && S.Ly > 0)) throw new Error('격자판 크기는 0보다 커야 합니다');
        const g = L.grid(); log.push(`격자 ${g.Nx}×${g.Ny} (Δx ${g.dx.toFixed(2)} mm)`);
        break;
      }
      case 'set_fluid':
        if (o.preset) { if (!L.PRESETS[o.preset]) throw new Error(`유체 프리셋이 잘못되었습니다: ${o.preset} (demo, air, water)`); L.applyPreset(o.preset); }
        if (o.nu !== undefined) { S.nu = num(o.nu, 'ν'); S.preset = 'custom'; }
        if (o.rho !== undefined) { S.rho = num(o.rho, 'ρ'); S.preset = 'custom'; }
        if (o.les !== undefined) S.les = !!o.les;
        if (o.cs !== undefined) S.cs = num(o.cs, 'Cs');
        break;
      case 'set_edge': if (!EDGES.includes(o.edge)) throw new Error(`변 이름이 잘못되었습니다: ${o.edge}`); bc(S.edges[o.edge], o); break;
      case 'add_patch': {
        if (!EDGES.includes(o.edge)) throw new Error(`변 이름이 잘못되었습니다: ${o.edge}`);
        if (!Array.isArray(o.range) || o.range.length !== 2) throw new Error('구간 range [시작, 끝] mm가 필요합니다');
        const len = L.edgeLen(o.edge), [a, b] = o.range.map((v) => Math.min(len, Math.max(0, num(v, '구간'))));
        const p = { id: L.nextId(), edge: o.edge, s0: Math.min(a, b), s1: Math.max(a, b), type: 'velocity', ux: 0, uy: 0, p: 0 };
        bc(p, { ...o, type: o.type || 'velocity' });
        S.patches.push(p);
        break;
      }
      case 'update_object':
        for (const ob of targets(o.target)) {
          if (o.pos) [ob.cx, ob.cy] = o.pos.map((v, d) => num(v, '위치') - (d ? +S.oy || 0 : +S.ox || 0));
          if (o.move) { ob.cx += num(o.move[0] || 0, '이동'); ob.cy += num(o.move[1] || 0, '이동'); }
          if (o.rot !== undefined) ob.rot = ((num(o.rot, '각도') % 360) + 360) % 360;
          if (o.rot_add !== undefined) ob.rot = (((ob.rot + num(Array.isArray(o.rot_add) ? o.rot_add[2] : o.rot_add, '각도')) % 360) + 360) % 360;
          if (o.scale !== undefined) ob.scale = Math.max(0.01, num(o.scale, '배율'));
          if (o.scale_mul !== undefined) ob.scale = Math.max(0.01, ob.scale * num(o.scale_mul, '배율'));
          if (o.role) {
            if (!['solid', 'inlet', 'outlet'].includes(o.role)) throw new Error(`역할이 잘못되었습니다: ${o.role}`);
            if (o.role !== 'solid' && !ob.curves.every((c) => c.closed && c.points.length >= 3)) throw new Error(`${ob.name}은(는) 열린 커브라 유입/유출 영역이 될 수 없습니다`);
            ob.role = o.role; if (o.role !== 'solid') ob.kin.mode = 'off';
          }
          if (o.inlet_speed !== undefined) { ob.inlet.mode = 'normal'; ob.inlet.un = num(o.inlet_speed, '속도'); }
          if (o.outlet_p !== undefined) ob.outlet.p = num(o.outlet_p, '압력');
          if (o.kin) {
            const k = ob.kin, q = o.kin;
            if (q.mode) { if (!['off', 'free', 'hinge', 'drive'].includes(q.mode)) throw new Error(`운동 모드가 잘못되었습니다: ${q.mode}`); if (ob.role !== 'solid' && q.mode !== 'off') throw new Error(`${ob.name}은(는) 유입/유출 영역이라 움직일 수 없습니다`); k.mode = q.mode; }
            if (q.pivot) k.pl = q.pivot === 'center' ? [0, 0] : L.toLocal(ob, q.pivot.map((v, d) => num(v, '축 위치') - (d ? +S.oy || 0 : +S.ox || 0)));
            if (q.rpm !== undefined) k.rpm = Math.abs(num(q.rpm, 'rpm'));
            if (q.dir) k.dir = q.dir === 'cw' ? 'cw' : 'ccw';
            for (const key of ['inertia', 'spring', 'damping']) if (q[key]) k[key] = q[key];
            if (k.mode === 'drive' && !(k.rpm > 0)) throw new Error('구동 회전수(rpm)를 알려 주세요');
          }
        }
        break;
      case 'remove_object': { const ids = new Set(targets(o.target).map((x) => x.id)); S.objects = S.objects.filter((x) => !ids.has(x.id)); L.select(null); break; }
      case 'clear': if (o.what === 'objects') { S.objects = []; L.select(null); } else if (o.what === 'patches') S.patches = []; else if (o.what === 'emitters') S.emitters = []; else throw new Error(`지울 대상이 잘못되었습니다: ${o.what}`); break;
      case 'add_samples': L.addSamples(); log.push('샘플 도형을 불러옵니다'); break;
      case 'set_run':
        if (o.duration !== undefined) S.duration = num(o.duration, '해석 시간');
        if (o.ramp !== undefined) S.ramp = num(o.ramp, '램프');
        if (o.frames !== undefined) S.frames = Math.round(Math.min(400, Math.max(10, num(o.frames, '프레임'))));
        if (o.u_lat_max !== undefined) S.ulat = Math.min(0.2, Math.max(0.01, num(o.u_lat_max, 'u_lat')));
        if (o.sponge !== undefined) S.sponge = Math.min(25, Math.max(0, num(o.sponge, '흡수층')));
        break;
      case 'set_view':
        if (o.field) { if (!['umag', 'vort', 'pressure'].includes(o.field)) throw new Error(`2D 필드는 umag, vort, pressure 중 하나입니다: ${o.field}`); L.fieldSet(o.field); }
        if (o.vectors !== undefined) L.overlay('showVec', 'chkVec', o.vectors);
        if (o.streams !== undefined) L.overlay('showStream', 'chkStream', o.streams);
        if (o.particles !== undefined) L.overlay('showPart', 'chkPart', o.particles);
        if (o.mask !== undefined) L.mask(o.mask);
        if (o.grid !== undefined) L.gridLines(o.grid);
        if (o.mode) L.setView(o.mode === 'result' ? 'result' : 'edit');
        else if (o.field || o.vectors || o.streams || o.particles) L.setView('result');
        if (!L.hasRun() && (o.field || o.streams || o.vectors)) log.push('결과는 해석을 실행하면 이 설정으로 표시됩니다');
        break;
      case 'plot': {
        $('bottom').classList.remove('collapsed');
        $('loadQty').value = o.qty || 'fx';
        if (o.target !== undefined) { const ob = targets(o.target)[0], opt = [...$('loadObj').options].find((x) => x.text === ob.name); if (opt) $('loadObj').value = opt.value; }
        L.drawLoadChart(); $('loadChart').scrollIntoView({ block: 'nearest', inline: 'nearest' });
        break;
      }
      case 'load_example': if (!L.examples().some((e) => e.file === o.name)) throw new Error(`예제 파일을 찾지 못했습니다: ${o.name}`); L.loadExample(o.name); break;
      case 'stop': L.stop(); break;
      case 'run': case 'analyze': break;
      default: throw new Error(`모르는 op입니다: ${o.op}`);
    }
  }
  refresh();
  return log;
}

function context() {
  const g = L.grid();
  const objs = S.objects.map((o, i) => ({ id: i + 1, name: o.name, center: [Math.round(o.cx + (+S.ox || 0)), Math.round(o.cy + (+S.oy || 0))], rot: o.rot, scale: o.scale, closed: o.curves.every((c) => c.closed), role: o.role, kin: o.kin.mode, selected: S.sel?.kind === 'obj' && S.sel.id === o.id }));
  const spec = { domain: { Lx: S.Lx, Ly: g.Ly, Nx: S.Nx, dx: g.dx, origin: [S.ox || 0, S.oy || 0] }, fluid: { preset: S.preset, nu: S.nu, rho: S.rho, les: S.les, cs: S.cs }, edges: S.edges, patches: S.patches.map(({ id, ...p }) => p), objects: objs, run: { duration: S.duration, ramp: S.ramp, frames: S.frames, u_lat_max: S.ulat, sponge: S.sponge }, view: { mode: S.view, field: S.field } };
  return `SPEC: ${JSON.stringify(spec)}\nPARAMS: ${L.paramsText()}\nSTATE: ${L.state()}\nEXAMPLES: ${JSON.stringify(L.examples())}`;
}

function ruleCtx() {
  const e = Object.entries(S.edges), inv = { left: 'xmin', right: 'xmax', bottom: 'ymin', top: 'ymax' };
  const sel = L.selObj();
  return { objects: S.objects.map((o) => o.name), selected: sel ? S.objects.indexOf(sel) : null, inletFace: inv[(e.find(([, b]) => b.type === 'velocity') || ['left'])[0]], outletFace: inv[(e.find(([, b]) => b.type === 'pressure' || b.type === 'outflow') || ['right'])[0]], faceTypes: Object.fromEntries(e.map(([k, b]) => [inv[k], b.type])), examples: L.examples(), paramsText: L.paramsText() };
}

bindBottom();
mountAgent($('agentPanel'), {
  system: SYSTEM2,
  placeholder: '예: 왼쪽에서 2 m/s로 불고 오른쪽은 압력 0, 위아래는 미끄럼벽',
  welcome: '조건을 문장으로 입력하면 왼쪽 설정에 바로 반영합니다. 규칙으로 이해한 문장은 LLM 없이 처리하고, 나머지는 LLM을 연결하면 처리합니다.',
  chips: ['왼쪽에서 2 m/s, 오른쪽은 압력 0', '위아래는 미끄럼벽', '샘플 5종 추가', '공기로 바꾸고 격자 분할 600', '해석 시간 20초로 하고 실행', '와도 보여줘', '항력 그래프'],
  rules: (text) => parse(text, 2, ruleCtx()),
  context, apply, snapshot, restore,
  run: () => { if (!L.locked()) L.run(); },
});
