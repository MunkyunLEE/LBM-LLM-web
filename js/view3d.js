import * as THREE from './vendor/three/three.module.min.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';

const BC_COLOR = { velocity: 0x4f8cff, pressure: 0xe5534b, outflow: 0xf0a13a, slip: 0x3fb950 };
const FACE_FILL = { velocity: 0x4f8cff, pressure: 0xe5534b, outflow: 0xf0a13a };
export const PROBE_COLORS = [0xff4d6d, 0xffb703, 0x06d6a0, 0x4cc9f0, 0xc77dff, 0xf72585, 0x8ac926, 0xff7f11];
const OBJ_COLOR = [0x8fa3c7, 0xc79f8f, 0x8fc7a6, 0xb98fc7, 0xc7c08f, 0x8fc2c7];

function cssVar(n) {
  return getComputedStyle(document.documentElement).getPropertyValue(n).trim();
}

function quadGeom(p0, pu, pv) {
  const g = new THREE.BufferGeometry(), P = [p0, p0.clone().add(pu), p0.clone().add(pu).add(pv), p0.clone().add(pv)];
  g.setAttribute('position', new THREE.Float32BufferAttribute(P.flatMap((p) => [p.x, p.y, p.z]), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

export class View3D {
  constructor(el, cb) {
    this.el = el; this.cb = cb;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    el.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 1e6);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.12;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.6));
    const dl = new THREE.DirectionalLight(0xffffff, 1.6); dl.position.set(0.6, -0.8, 1.4); this.scene.add(dl);
    this.dl = dl;
    this.groups = {};
    this.local = new THREE.Group();
    this.scene.add(this.local);
    for (const k of ['domain', 'grid', 'bc', 'voxels', 'slices', 'vectors', 'streams', 'parts', 'stream3d', 'iso', 'probes']) { this.groups[k] = new THREE.Group(); this.local.add(this.groups[k]); }
    for (const k of ['objects', 'helpers']) { this.groups[k] = new THREE.Group(); this.scene.add(this.groups[k]); }
    this.renderer.localClippingEnabled = true;
    this.clipPlanes = [];
    this.origin = [0, 0, 0];
    this.buildGizmo();
    this.meshes = []; this.sel = -1; this.mode = 'edit'; this.ray = new THREE.Raycaster();
    this.dom = { Lx: 1000, Ly: 1000, Lz: 1000 };
    this.bodyRot = new Map();
    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    this.applyTheme();
    const loop = () => { this.controls.update(); this.renderNow(); requestAnimationFrame(loop); };
    loop();
  }

  resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  applyTheme() {
    this.scene.background = new THREE.Color(cssVar('--stage') || '#0b0f16');
    this.light = document.documentElement.dataset.theme === 'light';
    if (this.lastDomain) this.setDomain(...this.lastDomain);
    if (this.objList) this.setObjects(this.objList, this.sel);
  }

  clear(g) {
    const grp = this.groups[g];
    while (grp.children.length) {
      const c = grp.children.pop();
      c.traverse?.((o) => { o.geometry?.dispose(); if (o.material) { o.material.map?.dispose(); o.material.dispose(); } });
    }
  }

  setDomain(Lx, Ly, Lz, dxmm, faces, patches, showGrid = true) {
    this.lastDomain = [Lx, Ly, Lz, dxmm, faces, patches, showGrid];
    this.dom = { Lx, Ly, Lz, dxmm };
    this.clear('domain'); this.clear('grid'); this.clear('bc');
    const edgeCol = this.light ? 0x6b7280 : 0x8a94a8;
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(Lx, Ly, Lz)), new THREE.LineBasicMaterial({ color: edgeCol }));
    box.position.set(Lx / 2, Ly / 2, Lz / 2);
    this.groups.domain.add(box);
    const L = Math.max(Lx, Ly, Lz) * 0.08, ax = [[1, 0, 0, 0xe5534b], [0, 1, 0, 0x3fb950], [0, 0, 1, 0x4f8cff]];
    for (const [x, y, z, c] of ax) {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(x * L, y * L, z * L)]);
      this.groups.domain.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: c, depthTest: false })));
    }
    const floorMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(cssVar('--cv-domain') || '#141a24'), transparent: true, opacity: this.light ? 0.85 : 0.6, side: THREE.DoubleSide, depthWrite: false });
    const floor = new THREE.Mesh(quadGeom(new THREE.Vector3(0, 0, 0), new THREE.Vector3(Lx, 0, 0), new THREE.Vector3(0, Ly, 0)), floorMat);
    floor.renderOrder = -2;
    this.groups.domain.add(floor);
    const nx = Math.round(Lx / dxmm), ny = Math.round(Ly / dxmm), nz = Math.round(Lz / dxmm);
    let m = 1;
    while (Math.max(nx, ny, nz) / m > 120) m *= 2;
    const minor = [], major = [], step = dxmm * m;
    const push = (arr, a, b) => arr.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    const lines = (n, fn) => { for (let i = 0; i <= n; i++) fn(i, (i * m) % (m * 10) === 0 || i === n); };
    lines(Math.floor(nx / m), (i, mj) => { const x = Math.min(i * step, Lx); push(mj ? major : minor, [x, 0, 0], [x, Ly, 0]); if (mj) push(major, [x, Ly, 0], [x, Ly, Lz]); });
    lines(Math.floor(ny / m), (i, mj) => { const y = Math.min(i * step, Ly); push(mj ? major : minor, [0, y, 0], [Lx, y, 0]); if (mj) push(major, [0, y, 0], [0, y, Lz]); });
    lines(Math.floor(nz / m), (i, mj) => { const z = Math.min(i * step, Lz); if (mj) { push(major, [0, Ly, z], [Lx, Ly, z]); push(major, [0, 0, z], [0, Ly, z]); } });
    const gc = this.light ? 0x1e2a44 : 0xdce6ff;
    for (const [arr, op] of [[minor, this.light ? 0.08 : 0.07], [major, this.light ? 0.2 : 0.16]]) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      this.groups.grid.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: gc, transparent: true, opacity: op, depthWrite: false })));
    }
    this.groups.grid.visible = showGrid;
    this.gridStep = step;
    const F = { xmin: [[0, 0, 0], [0, Ly, 0], [0, 0, Lz]], xmax: [[Lx, 0, 0], [0, Ly, 0], [0, 0, Lz]], ymin: [[0, 0, 0], [Lx, 0, 0], [0, 0, Lz]], ymax: [[0, Ly, 0], [Lx, 0, 0], [0, 0, Lz]], zmin: [[0, 0, 0], [Lx, 0, 0], [0, Ly, 0]], zmax: [[0, 0, Lz], [Lx, 0, 0], [0, Ly, 0]] };
    for (const [k, b] of Object.entries(faces || {})) {
      const col = FACE_FILL[b.type];
      if (!col) continue;
      const [p0, pu, pv] = F[k].map((a) => new THREE.Vector3(...a));
      const mesh = new THREE.Mesh(quadGeom(p0, pu, pv), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }));
      mesh.renderOrder = -1;
      this.groups.bc.add(mesh);
    }
    const NAX = { xmin: [0, 0], xmax: [0, 1], ymin: [1, 0], ymax: [1, 1], zmin: [2, 0], zmax: [2, 1] };
    (patches || []).forEach((p, i) => {
      const [a, side] = NAX[p.face] || [0, 0], ua = a === 0 ? 1 : 0, va = a === 2 ? 1 : 2, Ls = [Lx, Ly, Lz];
      const off = (side ? Ls[a] : 0) + (side ? -1 : 1) * Math.max(Lx, Ly, Lz) * 0.002;
      let pts2;
      if (p.shape === 'circle') { pts2 = []; for (let t = 0; t < 48; t++) pts2.push([+p.cu + p.r * Math.cos(t / 48 * 2 * Math.PI), +p.cv + p.r * Math.sin(t / 48 * 2 * Math.PI)]); }
      else if (p.shape === 'poly') pts2 = p.pts;
      else pts2 = [[p.cu - p.a / 2, p.cv - p.b / 2], [p.cu + p.a / 2, p.cv - p.b / 2], [p.cu + p.a / 2, p.cv + p.b / 2], [p.cu - p.a / 2, p.cv + p.b / 2]];
      const to3 = ([u, v]) => { const q = [0, 0, 0]; q[a] = off; q[ua] = u; q[va] = v; return new THREE.Vector3(...q); };
      const shape = new THREE.Shape(pts2.map(([u, v]) => new THREE.Vector2(u, v)));
      const sg = new THREE.ShapeGeometry(shape), pos = sg.attributes.position;
      for (let j = 0; j < pos.count; j++) { const v = to3([pos.getX(j), pos.getY(j)]); pos.setXYZ(j, v.x, v.y, v.z); }
      const col = BC_COLOR[p.type] || 0x4f8cff;
      const mesh = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: i === this.patchSel ? 0.75 : 0.45, side: THREE.DoubleSide, depthWrite: false }));
      this.groups.bc.add(mesh);
      const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts2.map(to3)), new THREE.LineBasicMaterial({ color: col }));
      this.groups.bc.add(ring);
    });
  }

  setObjects(list, sel) {
    this.objList = list;
    this.clear('objects');
    this.meshes = [];
    list.forEach((o, i) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(o.mesh.v, 3));
      g.setIndex(new THREE.BufferAttribute(o.mesh.f, 1));
      g.computeVertexNormals();
      const role = o.role || 'solid';
      const color = role === 'inlet' ? BC_COLOR.velocity : role === 'outlet' ? BC_COLOR.pressure : o.color ? new THREE.Color(o.color) : OBJ_COLOR[i % OBJ_COLOR.length];
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05, flatShading: true, side: THREE.DoubleSide, transparent: role !== 'solid', opacity: role !== 'solid' ? 0.45 : 1, clippingPlanes: this.clipPlanes });
      const mesh = new THREE.Mesh(g, mat);
      const pivot = new THREE.Group();
      pivot.add(mesh);
      pivot.userData.index = i; mesh.userData.index = i;
      this.groups.objects.add(pivot);
      this.meshes.push({ pivot, mesh });
      this.updateObject(i, o);
    });
    this.select(sel ?? -1);
  }

  updateObject(i, o) {
    const m = this.meshes[i];
    if (!m) return;
    const r = o.rot || [0, 0, 0], d = Math.PI / 180;
    m.mesh.position.set(...(o.pos || [0, 0, 0]));
    m.mesh.rotation.set(r[0] * d, r[1] * d, r[2] * d, 'XYZ');
    m.mesh.scale.setScalar(+(o.scale ?? 1));
    m.mesh.updateMatrix();
    m.kin = o.kin && o.kin.mode !== 'off' ? o.kin : null;
    this.applyBodyRot(i);
    if (i === this.sel) this.buildHelpers();
  }

  applyBodyRot(i) {
    const m = this.meshes[i], th = this.mode === 'result' ? (this.bodyRot.get(i) || 0) : 0;
    m.pivot.matrixAutoUpdate = false;
    if (!m.kin || !th) { m.pivot.matrix.identity(); m.pivot.matrixWorldNeedsUpdate = true; return; }
    const p = new THREE.Vector3(...(m.kin.pivot || [0, 0, 0])), a = new THREE.Vector3(...(m.kin.axis || [1, 0, 0])).normalize();
    const M = new THREE.Matrix4().makeTranslation(p.x, p.y, p.z).multiply(new THREE.Matrix4().makeRotationAxis(a, th)).multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
    m.pivot.matrix.copy(M); m.pivot.matrixWorldNeedsUpdate = true;
  }

  setBodyAngles(map) {
    this.bodyRot = map;
    this.meshes.forEach((_, i) => this.applyBodyRot(i));
  }

  worldBox(i) {
    const m = this.meshes[i];
    m.mesh.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(m.mesh, true);
  }

  anchors(i) {
    const b = this.worldBox(i), a = b.min, c = b.max, mid = a.clone().add(c).multiplyScalar(0.5), out = [];
    for (const x of [a.x, c.x]) for (const y of [a.y, c.y]) for (const z of [a.z, c.z]) out.push(new THREE.Vector3(x, y, z));
    for (let d = 0; d < 3; d++) for (const e of [a, c]) { const p = mid.clone(); p.setComponent(d, e.getComponent(d)); out.push(p); }
    return out;
  }

  select(i) {
    this.sel = i;
    this.meshes.forEach((m, j) => { m.mesh.material.emissive?.setHex(j === i ? (this.light ? 0x203a80 : 0x1d3a8a) : 0x000000); });
    this.buildHelpers();
  }

  buildHelpers(hi = -1) {
    this.clear('helpers');
    const i = this.sel;
    if (i < 0 || !this.meshes[i] || this.mode !== 'edit') return;
    const box = this.worldBox(i), D = Math.max(this.dom.Lx, this.dom.Ly, this.dom.Lz);
    this.groups.helpers.add(new THREE.Box3Helper(box, this.light ? 0x2f5bea : 0x6d95ff));
    const r = D * 0.006, sg = new THREE.SphereGeometry(r, 12, 8);
    this.anchorMeshes = this.anchors(i).map((p, k) => {
      const s = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: k === hi ? 0xffcc33 : (k < 8 ? 0xffffff : 0x9ab8ff), depthTest: false }));
      s.position.copy(p); s.renderOrder = 5; s.userData.anchor = k;
      this.groups.helpers.add(s);
      return s;
    });
    const k = this.meshes[i].kin;
    if (k) {
      const p = new THREE.Vector3(...(k.pivot || [0, 0, 0])), a = new THREE.Vector3(...(k.axis || [1, 0, 0])).normalize(), L = D * 0.18;
      const arrow = new THREE.ArrowHelper(a, p.clone().addScaledVector(a, -L / 2), L, 0xffcc33, L * 0.12, L * 0.06);
      arrow.traverse((o) => { if (o.material) { o.material.depthTest = false; } o.renderOrder = 6; });
      this.groups.helpers.add(arrow);
      const pm = new THREE.Mesh(new THREE.SphereGeometry(r * 1.6, 14, 10), new THREE.MeshBasicMaterial({ color: 0xffcc33, depthTest: false }));
      pm.position.copy(p); pm.renderOrder = 6;
      this.groups.helpers.add(pm);
    }
  }

  setMode(mode) {
    this.mode = mode;
    for (const k of ['slices', 'vectors', 'streams', 'parts', 'stream3d', 'iso']) this.groups[k].visible = mode === 'result';
    this.meshes.forEach((_, i) => this.applyBodyRot(i));
    this.buildHelpers();
  }

  setObjectsTranslucent(on) {
    this.meshes.forEach((m) => {
      const solid = (this.objList[m.mesh.userData.index]?.role || 'solid') === 'solid';
      if (!solid) return;
      m.mesh.material.transparent = on; m.mesh.material.opacity = on ? 0.35 : 1; m.mesh.material.depthWrite = !on; m.mesh.material.needsUpdate = true;
    });
  }

  setVoxels(cells, dxmm, palette) {
    this.clear('voxels');
    if (!cells) return;
    const n = cells.length / 4, geo = new THREE.BoxGeometry(dxmm * 0.92, dxmm * 0.92, dxmm * 0.92);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const inst = new THREE.InstancedMesh(geo, mat, n), M = new THREE.Matrix4(), C = new THREE.Color();
    for (let q = 0; q < n; q++) {
      M.makeTranslation((cells[4 * q] + 0.5) * dxmm, (cells[4 * q + 1] + 0.5) * dxmm, (cells[4 * q + 2] + 0.5) * dxmm);
      inst.setMatrixAt(q, M);
      inst.setColorAt(q, C.setHex(palette(cells[4 * q + 3])));
    }
    this.groups.voxels.add(inst);
  }

  setSliceMeshes(list) {
    this.clear('slices');
    for (const s of list) {
      const tex = new THREE.DataTexture(s.rgba, s.w, s.h, THREE.RGBAFormat);
      tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
      const mesh = new THREE.Mesh(quadGeom(...s.quad.map((a) => new THREE.Vector3(...a))), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true, opacity: 0.96 }));
      this.groups.slices.add(mesh);
    }
  }

  setLines(group, arr, color, opacity = 1) {
    this.clear(group);
    if (!arr || !arr.length) return;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    this.groups[group].add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity })));
  }

  setParticles(pos, col, size) {
    this.clear('parts');
    if (!pos || !pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.groups.parts.add(new THREE.Points(g, new THREE.PointsMaterial({ size, sizeAttenuation: false, vertexColors: true })));
  }

  camPreset(kind) {
    const { Lx, Ly, Lz } = this.dom, c = new THREE.Vector3(Lx / 2, Ly / 2, Lz / 2).add(new THREE.Vector3(...this.origin)), R = Math.hypot(Lx, Ly, Lz) * 1.25;
    const dir = { iso: [0.9, -1.3, 0.85], top: [0, -0.0001, 1], front: [0, -1, 0.0001], side: [1, 0, 0.0001] }[kind] || [0.9, -1.3, 0.85];
    const d = new THREE.Vector3(...dir).normalize();
    this.camera.position.copy(c.clone().addScaledVector(d, R));
    this.camera.near = R / 500; this.camera.far = R * 20; this.camera.updateProjectionMatrix();
    this.controls.target.copy(c); this.controls.update();
  }

  pick(ev, objs) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(v, this.camera);
    return this.ray.intersectObjects(objs, false);
  }

  bindPointer() {
    const el = this.renderer.domElement;
    let drag = null, down = null;
    el.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const gz = this.gizmoHit(ev);
      if (gz) { if (gz !== 'pad') this.viewFrom(gz); ev.stopImmediatePropagation(); this.controls.enabled = false; drag = { anchorOnly: true }; return; }
      if (this.pickProbe && this.mode === 'result') {
        const p = this.hitSlices(ev);
        if (p) { this.cb.onProbe?.(p.clone().add(new THREE.Vector3(...this.origin)).toArray()); this.controls.enabled = false; drag = { anchorOnly: true }; return; }
      }
      down = { x: ev.clientX, y: ev.clientY };
      if (this.mode !== 'edit') return;
      if (this.pickAnchor && this.anchorMeshes) {
        const h = this.pick(ev, this.anchorMeshes);
        if (h.length) { this.cb.onAnchor?.(this.sel, h[0].object.position.toArray()); ev.stopPropagation(); this.controls.enabled = false; drag = { anchorOnly: true }; return; }
      }
      const hit = this.pick(ev, this.meshes.map((m) => m.mesh));
      if (!hit.length) return;
      const i = hit[0].object.userData.index;
      if (i !== this.sel) { this.cb.onSelect?.(i); }
      const o = this.objList[i], p0 = hit[0].point.clone();
      const n = ev.shiftKey ? (() => { const d = new THREE.Vector3(); this.camera.getWorldDirection(d); d.z = 0; if (d.lengthSq() < 1e-9) d.set(0, 1, 0); return d.normalize(); })() : new THREE.Vector3(0, 0, 1);
      drag = { i, vertical: ev.shiftKey, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, p0), p0, pos0: (o.pos || [0, 0, 0]).slice(), moved: false };
      this.controls.enabled = false;
      el.setPointerCapture(ev.pointerId);
    });
    el.addEventListener('pointermove', (ev) => {
      if (!drag) { this.cb.onHover?.(ev); return; }
      if (drag.anchorOnly) return;
      const r = el.getBoundingClientRect();
      const v = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      this.ray.setFromCamera(v, this.camera);
      const q = new THREE.Vector3();
      if (!this.ray.ray.intersectPlane(drag.plane, q)) return;
      const d = q.sub(drag.p0);
      const prop = drag.vertical ? [drag.pos0[0], drag.pos0[1], drag.pos0[2] + d.z] : [drag.pos0[0] + d.x, drag.pos0[1] + d.y, drag.pos0[2]];
      drag.moved = true;
      this.cb.onDrag?.(drag.i, prop, drag.vertical ? [false, false, true] : [true, true, false]);
    });
    const end = (ev) => {
      if (drag && !drag.anchorOnly && drag.moved) this.cb.onDragEnd?.(drag.i);
      if (!drag && down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 4 && this.mode === 'edit') this.cb.onSelect?.(-1);
      drag = null; down = null; this.controls.enabled = true;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  rayAt(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(v, this.camera);
    return this.ray;
  }

  hitSlices(ev) {
    this.rayAt(ev);
    const h = this.ray.intersectObjects(this.groups.slices.children, false);
    return h.length ? h[0].point.clone().sub(new THREE.Vector3(...this.origin)) : null;
  }

  canvas() { return this.renderer.domElement; }

  renderNow() {
    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.el.clientWidth, this.el.clientHeight);
    r.render(this.scene, this.camera);
    const sz = 120, w = this.el.clientWidth, h = this.el.clientHeight;
    const d = this.camera.position.clone().sub(this.controls.target).normalize().multiplyScalar(4);
    this.gcam.position.copy(d); this.gcam.up.copy(this.camera.up); this.gcam.lookAt(0, 0, 0);
    r.autoClear = false;
    r.setScissorTest(true);
    r.setScissor(w - sz - 8, h - sz - 8, sz, sz); r.setViewport(w - sz - 8, h - sz - 8, sz, sz);
    r.clearDepth();
    r.render(this.gscene, this.gcam);
    r.setScissorTest(false); r.autoClear = true;
    r.setViewport(0, 0, w, h);
  }

  buildGizmo() {
    this.gscene = new THREE.Scene();
    this.gcam = new THREE.OrthographicCamera(-1.75, 1.75, 1.75, -1.75, 0.1, 20);
    const label = (t, col) => {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const g = c.getContext('2d'); g.fillStyle = col; g.beginPath(); g.arc(32, 32, 26, 0, 7); g.fill();
      g.fillStyle = '#fff'; g.font = 'bold 34px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, 32, 34);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
      sp.scale.set(0.62, 0.62, 1);
      return sp;
    };
    for (const [v, col, t] of [[[1, 0, 0], '#e5534b', 'X'], [[0, 1, 0], '#3fb950', 'Y'], [[0, 0, 1], '#4f8cff', 'Z']]) {
      const dir = new THREE.Vector3(...v), c = new THREE.Color(col);
      this.gscene.add(new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0), 1.05, c, 0.3, 0.16));
      const sp = label(t, col); sp.position.copy(dir.clone().multiplyScalar(1.3)); this.gscene.add(sp);
      const neg = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.5 }));
      neg.position.copy(dir.clone().multiplyScalar(-1)); this.gscene.add(neg);
    }
    this.gscene.add(new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), new THREE.MeshBasicMaterial({ color: 0x8a94a8 })));
  }

  gizmoHit(ev) {
    const r = this.renderer.domElement.getBoundingClientRect(), sz = 120, x = ev.clientX - r.left, y = ev.clientY - r.top;
    if (x < r.width - sz - 8 || y > sz + 8) return null;
    const v = new THREE.Vector2(((x - (r.width - sz - 8)) / sz) * 2 - 1, -((y - 8) / sz) * 2 + 1);
    this.ray.setFromCamera(v, this.gcam);
    const hit = this.ray.intersectObjects(this.gscene.children.filter((o) => o.isSprite), false);
    return hit.length ? hit[0].object.position.clone().normalize() : 'pad';
  }

  viewFrom(dir) {
    const { Lx, Ly, Lz } = this.dom, c = new THREE.Vector3(Lx / 2, Ly / 2, Lz / 2).add(new THREE.Vector3(...this.origin)), R = Math.hypot(Lx, Ly, Lz) * 1.25;
    const d = dir.clone(); if (Math.abs(d.z) > 0.999) d.y -= 0.0001;
    this.camera.position.copy(c.clone().addScaledVector(d.normalize(), R));
    this.controls.target.copy(c); this.controls.update();
  }

  setOrigin(o) {
    this.origin = o.slice();
    this.local.position.set(...o);
    this.updateClip();
  }

  setClip(on) { this.clipOn = on; this.updateClip(); }

  updateClip() {
    const o = this.origin, { Lx, Ly, Lz } = this.dom;
    this.clipPlanes = this.clipOn ? [
      new THREE.Plane(new THREE.Vector3(1, 0, 0), -o[0]), new THREE.Plane(new THREE.Vector3(-1, 0, 0), o[0] + Lx),
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -o[1]), new THREE.Plane(new THREE.Vector3(0, -1, 0), o[1] + Ly),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), -o[2]), new THREE.Plane(new THREE.Vector3(0, 0, -1), o[2] + Lz)] : [];
    for (const m of this.meshes || []) { m.mesh.material.clippingPlanes = this.clipPlanes; m.mesh.material.needsUpdate = true; }
  }

  setProbes(list, dxmm) {
    this.clear('probes');
    const D = Math.max(this.dom.Lx, this.dom.Ly, this.dom.Lz), g = new THREE.SphereGeometry(D * 0.008, 14, 10);
    list.forEach((p, i) => {
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: PROBE_COLORS[i % PROBE_COLORS.length], depthTest: false }));
      m.position.set(p[0] - this.origin[0], p[1] - this.origin[1], p[2] - this.origin[2]); m.renderOrder = 7;
      this.groups.probes.add(m);
    });
  }

  setColoredLines(group, pos, col) {
    this.clear(group);
    if (!pos || !pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.groups[group].add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true })));
  }

  setIso(pos, col) {
    this.clear('iso');
    if (!pos || !pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    this.groups.iso.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })));
  }
}
