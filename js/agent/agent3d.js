import { mountAgent } from '../simweb/panel.js';
import { parse } from './rules.js';
import { SYSTEM3 } from './prompts.js';
import { bbox } from '../lbm3d/mesh.js';

const FACES = ['xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax'];
const TYPES = ['velocity', 'pressure', 'outflow', 'wall', 'slip', 'periodic'];
const FLUIDS = { air: { nu: 1.5e-5, rho: 1.2 }, water: { nu: 1.0e-6, rho: 998 } };
const AXV = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const $ = (id) => document.getElementById(id);
const num = (v, name) => { const x = +v; if (!Number.isFinite(x)) throw new Error(`${name} 값이 숫자가 아닙니다: ${v}`); return x; };
const r2 = (v) => Math.round(v * 100) / 100;

function cloneS(src) {
  const meshes = src.objects.map((o) => [o.mesh, o._mesh]);
  const c = JSON.parse(JSON.stringify(src, (k, v) => (k === 'mesh' || k === '_mesh' ? undefined : v)));
  c.objects.forEach((o, i) => { [o.mesh, o._mesh] = meshes[i]; if (!o._mesh) delete o._mesh; });
  return c;
}

export function attach3d(H) {
  const S = () => H.S;
  const center = (o) => H.centerOf(o);
  const shift = (o, d) => { const old = center(o); o.pos = o.pos.map((v, i) => v + d[i]); if (o.kin.pivot) { const c = center(o); o.kin.pivot = o.kin.pivot.map((v, i) => v + c[i] - old[i]); } };

  function targets(t, lastIdx) {
    const objs = S().objects;
    if (t === 'all') return objs.map((_, i) => i);
    if (t === 'last') { if (lastIdx == null) throw new Error('방금 추가한 객체가 없습니다'); return [lastIdx]; }
    if (t === 'selected') { if (H.sel() >= 0) return [H.sel()]; if (objs.length === 1) return [0]; throw new Error('선택된 객체가 없습니다. 객체 번호나 이름을 알려 주세요.'); }
    if (typeof t === 'number' || /^\d+$/.test(String(t))) { const i = +t - 1; if (!objs[i]) throw new Error(`${t}번 객체가 없습니다 (현재 ${objs.length}개)`); return [i]; }
    const i = objs.findIndex((o) => o.name === t), j = i >= 0 ? i : objs.findIndex((o) => o.name.toLowerCase().includes(String(t).toLowerCase()));
    if (j < 0) throw new Error(`'${t}' 객체를 찾지 못했습니다. 있는 객체: ${objs.map((o) => o.name).join(', ') || '없음'}`);
    return [j];
  }

  function setFace(o) {
    const s = S(), k = o.face;
    if (!FACES.includes(k)) throw new Error(`면 이름이 잘못되었습니다: ${k}`);
    const type = o.type || s.faces[k].type;
    if (!TYPES.includes(type)) throw new Error(`경계 종류가 잘못되었습니다: ${type}`);
    const opp = FACES[FACES.indexOf(k) ^ 1], was = s.faces[k].type;
    if (type === 'periodic') s.faces[opp] = { type: 'periodic' };
    else if (was === 'periodic' && s.faces[opp].type === 'periodic') s.faces[opp] = { type: 'slip' };
    const b = type === was ? { ...s.faces[k] } : { type, ux: 0, uy: 0, uz: 0, p: 0 };
    b.type = type;
    if (type === 'velocity') {
      const a = Math.floor(FACES.indexOf(k) / 2), sg = FACES.indexOf(k) % 2 ? -1 : 1;
      if (Array.isArray(o.u)) [b.ux, b.uy, b.uz] = o.u.map((v) => num(v, 'u'));
      else if (o.speed !== undefined) { const u = [0, 0, 0]; u[a] = sg * Math.abs(num(o.speed, '속도')); [b.ux, b.uy, b.uz] = u; }
      else if (type !== was) { const u = [0, 0, 0]; u[a] = sg; [b.ux, b.uy, b.uz] = u; }
      if (o.profile) {
        const p = o.profile;
        if (p.type === 'power') b.profile = { type: 'power', zref: num(p.zref ?? 10000, 'zref'), alpha: num(p.alpha ?? 0.22, 'alpha') };
        else if (p.type === 'log') b.profile = { type: 'log', zref: num(p.zref ?? 10000, 'zref'), z0: num(p.z0 ?? 300, 'z0') };
        else b.profile = { type: 'uniform' };
        if (b.profile.type !== 'uniform' && k[0] === 'z') throw new Error('대기경계층 분포는 수평 방향(x, y) 유입면에만 줄 수 있습니다');
      }
    }
    if (type === 'pressure') b.p = o.p !== undefined ? num(o.p, '압력') : (b.p ?? 0);
    s.faces[k] = b;
  }

  function addObject(o) {
    const s = S(), g = H.g3(), D = Math.min(g.Lx, g.Ly, g.Lz), O = s.origin;
    const c = [g.Lx * 0.3, g.Ly / 2, g.Lz / 2].map((v, d) => Math.round(v / 10) * 10 + O[d]);
    const n = s.objects.length + 1;
    let spec;
    if (o.shape === 'sphere') spec = { name: o.name || `구 ${n}`, mesh: { gen: { type: 'sphere', r: num(o.r ?? Math.round(D * 0.1), '반지름'), seg: 24 } } };
    else if (o.shape === 'box') { const [a, b, cc] = (o.size || [D * 0.2, D * 0.2, D * 0.2]).map((v) => num(v, '크기')); spec = { name: o.name || `상자 ${n}`, mesh: { gen: { type: 'box', a, b, c: cc } } }; }
    else if (o.shape === 'plate') { const [a, b, cc] = (o.size || [D * 0.02, D * 0.4, D * 0.3]).map((v) => num(v, '크기')); spec = { name: o.name || `판 ${n}`, mesh: { gen: { type: 'box', a, b, c: cc } }, voxel: 'both' }; }
    else if (o.shape === 'rotor') spec = { name: o.name || `로터 ${n}`, mesh: { gen: { type: 'rotor', R: num(o.R ?? Math.round(D * 0.28), '반지름'), blades: Math.round(o.blades ?? 3), pitch: 30 } }, voxel: 'both', kin: { mode: 'free', axis: [1, 0, 0], axisSel: 'x', inertia: 'low', damping: 'low' } };
    else throw new Error(`만들 수 없는 형상입니다: ${o.shape} (sphere, box, rotor, plate만 가능)`);
    const ob = H.normObj({ ...spec, pos: [0, 0, 0] });
    const cen = o.pos === 'center' ? [g.Lx / 2 + O[0], g.Ly / 2 + O[1], g.Lz / 2 + O[2]] : Array.isArray(o.pos) ? o.pos.map((v) => num(v, '위치')) : c;
    ob.pos = cen.slice();
    if (o.on_floor || (!o.pos && o.shape === 'box')) { const [a] = bbox(H.objectVerts(ob)); ob.pos[2] += O[2] - a[2]; }
    ob.kin.pivot = center(ob);
    s.objects.push(ob);
    return s.objects.length - 1;
  }

  function updateObject(o, lastIdx, log) {
    const s = S(), g = H.g3();
    for (const i of targets(o.target, lastIdx)) {
      const ob = s.objects[i];
      if (o.name) ob.name = String(o.name);
      if (o.rot) ob.rot = o.rot.map((v) => num(v, '회전'));
      if (o.rot_add) { const ra = Array.isArray(o.rot_add) ? o.rot_add : [0, 0, o.rot_add]; const old = center(ob); ob.rot = ob.rot.map((v, d) => v + num(ra[d] || 0, '회전')); const c = center(ob); ob.pos = ob.pos.map((v, d) => v + old[d] - c[d]); }
      if (o.scale !== undefined || o.scale_mul !== undefined) { const old = center(ob); ob.scale = o.scale !== undefined ? num(o.scale, '배율') : ob.scale * num(o.scale_mul, '배율'); if (!(ob.scale > 0)) throw new Error('배율은 0보다 커야 합니다'); const c = center(ob); ob.pos = ob.pos.map((v, d) => v + old[d] - c[d]); }
      if (o.pos) { const c = center(ob); shift(ob, o.pos.map((v, d) => num(v, '위치') - c[d])); }
      if (o.move) shift(ob, o.move.map((v) => num(v || 0, '이동')));
      if (o.center) { const c = center(ob); shift(ob, [g.Lx / 2 + s.origin[0] - c[0], g.Ly / 2 + s.origin[1] - c[1], g.Lz / 2 + s.origin[2] - c[2]]); }
      if (o.on_floor) { const [a] = bbox(H.objectVerts(ob)); shift(ob, [0, 0, s.origin[2] - a[2]]); }
      if (o.role) { if (!['solid', 'inlet', 'outlet'].includes(o.role)) throw new Error(`역할이 잘못되었습니다: ${o.role}`); ob.role = o.role; if (o.role !== 'solid') ob.kin.mode = 'off'; }
      if (o.inlet_u) [ob.inlet.ux, ob.inlet.uy, ob.inlet.uz] = o.inlet_u.map((v) => num(v, '속도'));
      if (o.outlet_p !== undefined) ob.outlet.p = num(o.outlet_p, '압력');
      if (o.kin) {
        const k = ob.kin, q = o.kin;
        if (ob.role !== 'solid' && q.mode && q.mode !== 'off') throw new Error(`${ob.name}은(는) 유입/유출 영역이라 움직일 수 없습니다`);
        if (q.mode) { if (!['off', 'free', 'hinge', 'drive'].includes(q.mode)) throw new Error(`운동 모드가 잘못되었습니다: ${q.mode}`); k.mode = q.mode; }
        if (q.axis) { if (typeof q.axis === 'string') { if (!AXV[q.axis]) throw new Error(`회전축이 잘못되었습니다: ${q.axis}`); k.axis = AXV[q.axis].slice(); k.axisSel = q.axis; } else { k.axis = q.axis.map((v) => num(v, '축')); k.axisSel = 'custom'; } }
        if (q.pivot) k.pivot = q.pivot === 'center' ? center(ob) : q.pivot.map((v) => num(v, '축 위치'));
        if (q.rpm !== undefined) k.rpm = Math.abs(num(q.rpm, 'rpm'));
        if (q.dir) k.dir = q.dir === 'cw' ? 'cw' : 'ccw';
        for (const key of ['inertia', 'spring', 'damping']) if (q[key]) k[key] = q[key];
        if (!k.pivot) k.pivot = center(ob);
        if (k.mode === 'drive' && !(k.rpm > 0)) throw new Error('구동 회전수(rpm)를 알려 주세요');
        log.push(`${ob.name}: ${{ off: '고정', free: '자유 회전', hinge: '힌지', drive: `구동 ${k.rpm} rpm` }[k.mode]}, 축 ${k.axisSel || 'custom'}`);
      }
      H.updateObjView(i);
    }
  }

  function setView(o, log) {
    const s = S(), v = s.view;
    if (o.field) { if (!['umag', 'ux', 'uy', 'uz', 'pressure', 'vort'].includes(o.field)) throw new Error(`필드 이름이 잘못되었습니다: ${o.field}`); v.field = o.field; $('inField').value = o.field; H.resetRange(); }
    if (o.range) { v.range = o.range === 'run' ? 'run' : 'frame'; $('inRange').value = v.range; }
    let sl = false;
    for (const q of o.slices || []) {
      const P = String(q.axis).toUpperCase(), d = 'XYZ'.indexOf(P);
      if (d < 0) throw new Error(`단면 축이 잘못되었습니다: ${q.axis}`);
      v.slices[P].on = q.on !== false;
      if (q.at !== undefined) { const L = [H.g3().Lx, H.g3().Ly, H.g3().Lz][d]; v.slices[P].f = Math.min(0.999, Math.max(0.001, (num(q.at, '단면 위치') - s.origin[d]) / L)); }
      sl = true;
    }
    if (sl) H.slicesChanged();
    const chk = (id, val) => { if (val !== undefined) $(id).checked = !!val; };
    chk('chkVec', o.vectors); chk('chkStream', o.streams); chk('chkPart', o.particles); chk('chkMean', o.mean);
    if (o.stream_density !== undefined) { const el = $('inSdens'), cur = +el.value; el.value = o.stream_density === 'up' ? Math.min(10, cur + 3) : o.stream_density === 'down' ? Math.max(1, cur - 3) : Math.min(10, Math.max(1, Math.round(num(o.stream_density, '유선 밀도')))); el.dispatchEvent(new Event('input')); if (o.streams === undefined) $('chkStream').checked = true; }
    if (o.camera) H.view.camPreset(o.camera);
    if (o.mode) H.setMode(o.mode === 'result' ? 'result' : 'edit');
    else if (o.field || o.vectors || o.streams || o.particles) H.setMode('result');
    if ((o.field || o.streams || o.vectors) && !H.hasFrames()) log.push('결과는 해석을 실행하면 이 설정으로 표시됩니다');
  }

  function apply(ops) {
    const s = S(), log = [];
    let lastIdx = null, geo = false;
    if (!Array.isArray(ops)) throw new Error('ops가 배열이 아닙니다');
    const busy = H.locked();
    for (const o of ops) {
      switch (o.op) {
        case 'set_domain': {
          if (o.size) [s.Lx, s.Ly, s.Lz] = o.size.map((v) => num(v, '도메인 크기'));
          for (const k of ['Lx', 'Ly', 'Lz']) if (o[k] !== undefined) s[k] = num(o[k], k);
          if (o.dx !== undefined) s.dx = num(o.dx, 'Δx');
          if (o.cells_x) s.dx = r2(s.Lx / num(o.cells_x, '분할 수'));
          if (o.refine) s.dx = r2(s.dx / num(o.refine, '배율'));
          if (o.origin) s.origin = o.origin.map((v) => num(v, '원점'));
          if (!(s.dx > 0) || ![s.Lx, s.Ly, s.Lz].every((L) => L > 0)) throw new Error('도메인 크기와 Δx는 0보다 커야 합니다');
          const g = H.g3();
          log.push(`격자 ${g.Nx}×${g.Ny}×${g.Nz} (Δx ${r2(g.dxmm)} mm)`);
          geo = true; break;
        }
        case 'set_fluid':
          if (o.preset) { if (!FLUIDS[o.preset]) throw new Error(`유체 프리셋이 잘못되었습니다: ${o.preset} (air, water)`); Object.assign(s.fluid, FLUIDS[o.preset], { preset: o.preset }); }
          if (o.nu !== undefined) { s.fluid.nu = num(o.nu, 'ν'); s.fluid.preset = 'custom'; }
          if (o.rho !== undefined) s.fluid.rho = num(o.rho, 'ρ');
          if (o.les !== undefined) s.les.enabled = !!o.les;
          break;
        case 'set_face': setFace(o); geo = true; break;
        case 'add_patch': {
          const face = o.face || 'xmin';
          if (!FACES.includes(face)) throw new Error(`면 이름이 잘못되었습니다: ${face}`);
          const [U, V] = H.faceUV(face), type = o.type || 'velocity';
          if (!['velocity', 'pressure', 'outflow'].includes(type)) throw new Error('구간 종류는 velocity, pressure, outflow 중 하나입니다');
          const p = { face, shape: o.shape === 'circle' ? 'circle' : 'rect', type, un: o.speed !== undefined ? num(o.speed, '속도') : 1, p: o.p !== undefined ? num(o.p, '압력') : 0 };
          [p.cu, p.cv] = o.center ? o.center.map((v) => num(v, '중심')) : [Math.round(U / 2), Math.round(V / 2)];
          if (p.shape === 'rect') [p.a, p.b] = o.size ? o.size.map((v) => num(v, '크기')) : [Math.round(U / 4), Math.round(V / 4)];
          else p.r = o.r !== undefined ? num(o.r, '반지름') : Math.round(Math.min(U, V) / 8);
          s.patches.push(p); geo = true; break;
        }
        case 'add_object': lastIdx = addObject(o); H.setSel(lastIdx); geo = true; log.push(`${s.objects[lastIdx].name} 추가 (중심 ${center(s.objects[lastIdx]).join(', ')} mm)`); break;
        case 'update_object': updateObject(o, lastIdx, log); geo = true; break;
        case 'remove_object': { const idx = targets(o.target, lastIdx).sort((a, b) => b - a); for (const i of idx) s.objects.splice(i, 1); H.setSel(-1); geo = true; break; }
        case 'duplicate_object': {
          for (const i of targets(o.target, lastIdx)) {
            const src = s.objects[i], m = src.mesh.gen ? { gen: src.mesh.gen } : { v: H.meshOf(src).v.slice(), f: H.meshOf(src).f.slice() };
            const n = H.normObj({ ...JSON.parse(JSON.stringify({ ...src, _mesh: undefined, mesh: undefined })), mesh: m });
            n.name = `${src.name} 복사`; shift(n, [0, s.snap.step * 2, 0]); s.objects.push(n); lastIdx = s.objects.length - 1;
          }
          geo = true; break;
        }
        case 'clear':
          if (o.what === 'objects') { s.objects = []; H.setSel(-1); } else if (o.what === 'patches') s.patches = []; else if (o.what === 'probes') s.probes = []; else throw new Error(`지울 대상이 잘못되었습니다: ${o.what}`);
          geo = true; break;
        case 'set_run':
          if (o.duration !== undefined) s.duration = num(o.duration, '해석 시간');
          if (o.ramp !== undefined) s.ramp = num(o.ramp, '램프');
          if (o.frames !== undefined) s.frames = Math.round(Math.min(400, Math.max(10, num(o.frames, '프레임'))));
          if (o.u_lat_max !== undefined) s.u_lat_max = Math.min(0.15, Math.max(0.01, num(o.u_lat_max, 'u_lat')));
          if (o.sponge !== undefined) s.sponge = Math.min(25, Math.max(0, num(o.sponge, '흡수층')));
          if (o.avg_start !== undefined) s.avgStart = Math.max(0, num(o.avg_start, '평균 시작'));
          if (o.particles !== undefined) s.particles = Math.round(Math.min(100000, Math.max(0, num(o.particles, '입자 수'))));
          if (o.backend) s.backend = ['gpu', 'cpu'].includes(o.backend) ? o.backend : 'auto';
          if (s.duration <= 0) throw new Error('해석 시간은 0보다 커야 합니다');
          break;
        case 'add_probe': if (!Array.isArray(o.pos) || o.pos.length !== 3) throw new Error('프로브 좌표는 [x, y, z] mm 입니다'); s.probes.push(o.pos.map((v) => Math.round(num(v, '좌표')))); geo = true; break;
        case 'set_view': setView(o, log); break;
        case 'analyze': if (!H.hasRun()) { log.push('해석 결과가 아직 없어 분석은 실행 후 가능합니다'); break; } H.analyze(o.kind, o); break;
        case 'plot': H.plot(o, targets); break;
        case 'load_example': if (!H.examples().some((e) => e.file === o.name)) throw new Error(`예제 파일을 찾지 못했습니다: ${o.name}`); H.loadExample(o.name); log.push('예제를 불러옵니다'); break;
        case 'stop': H.stop(); break;
        case 'run': break;
        default: throw new Error(`모르는 op입니다: ${o.op}`);
      }
    }
    H.refreshAll(geo);
    if (busy && geo) log.push('지금 돌고 있는 해석에는 반영되지 않고 다음 실행부터 적용됩니다');
    return log;
  }

  function context() {
    const s = S(), g = H.g3();
    const objs = s.objects.map((o, i) => {
      const [a, b] = bbox(H.objectVerts(o));
      return { id: i + 1, name: o.name, shape: o.mesh.gen ? o.mesh.gen.type : 'mesh', bbox_mm: [a.map(Math.round), b.map(Math.round)], role: o.role, kin: o.kin.mode === 'off' ? 'off' : { mode: o.kin.mode, axis: o.kin.axisSel || o.kin.axis, rpm: o.kin.rpm }, selected: i === H.sel() };
    });
    const spec = { domain: { L: [s.Lx, s.Ly, s.Lz], dx: s.dx, origin: s.origin, cells: [g.Nx, g.Ny, g.Nz] }, fluid: { ...s.fluid, les: s.les.enabled }, faces: s.faces, patches: s.patches, objects: objs, run: { duration: s.duration, ramp: s.ramp, frames: s.frames, u_lat_max: s.u_lat_max, sponge: s.sponge, avg_start: s.avgStart, particles: s.particles, backend: s.backend }, probes: s.probes, view: { mode: s.mode, ...s.view } };
    return `SPEC: ${JSON.stringify(spec)}\nPARAMS: ${H.paramsText()}\nSTATE: ${H.state()}${H.hasRun() ? ' (results available)' : ''}\nEXAMPLES: ${JSON.stringify(H.examples())}`;
  }

  function ruleCtx() {
    const s = S(), faces = Object.entries(s.faces);
    return { objects: s.objects.map((o) => o.name), selected: H.sel() >= 0 ? H.sel() : null, inletFace: (faces.find(([, b]) => b.type === 'velocity') || ['xmin'])[0], outletFace: (faces.find(([, b]) => b.type === 'pressure' || b.type === 'outflow') || ['xmax'])[0], faceTypes: Object.fromEntries(faces.map(([k, b]) => [k, b.type])), examples: H.examples(), paramsText: H.paramsText() };
  }

  return mountAgent($('agentPanel'), {
    system: SYSTEM3,
    placeholder: '예: x 방향으로 5 m/s 바람, 바닥은 벽, 출구는 대기압으로 하고 해석 실행',
    welcome: '조건을 문장으로 입력하면 왼쪽 설정에 바로 반영합니다. 규칙으로 이해한 문장은 LLM 없이 처리하고, 나머지는 LLM을 연결하면 처리합니다.',
    chips: ['x 방향으로 5 m/s, 출구는 대기압', '교외 지형 대기경계층으로 10 m 높이에서 8 m/s', '바닥은 벽, 좌우와 천장은 미끄럼', '격자 더 촘촘하게', '해석 시간 10초로 하고 실행', 'Z 단면 1 m 압력 보여줘', '항력 그래프'],
    rules: (text) => parse(text, 3, ruleCtx()),
    context,
    apply,
    snapshot: () => ({ S: cloneS(S()), sel: H.sel() }),
    restore: (snap) => { H.setS(cloneS(snap.S)); H.setSel(snap.sel); H.refreshAll(true, true); },
    run: () => H.run(),
  });
}
