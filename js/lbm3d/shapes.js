function builder() {
  const v = [], f = [];
  return {
    v, f,
    p(x, y, z) { v.push(x, y, z); return v.length / 3 - 1; },
    t(a, b, c) { f.push(a, b, c); },
    q(a, b, c, d) { f.push(a, b, c, a, c, d); },
    done() { return { v: new Float32Array(v), f: new Uint32Array(f) }; },
  };
}

export function sphere(r, seg = 24) {
  const B = builder(), rings = seg, segs = seg * 2, top = B.p(0, 0, r), idx = [];
  for (let i = 1; i < rings; i++) {
    const th = Math.PI * i / rings, row = [];
    for (let j = 0; j < segs; j++) { const ph = 2 * Math.PI * j / segs; row.push(B.p(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th))); }
    idx.push(row);
  }
  const bot = B.p(0, 0, -r);
  for (let j = 0; j < segs; j++) B.t(top, idx[0][j], idx[0][(j + 1) % segs]);
  for (let i = 0; i + 1 < idx.length; i++) for (let j = 0; j < segs; j++) B.q(idx[i][j], idx[i + 1][j], idx[i + 1][(j + 1) % segs], idx[i][(j + 1) % segs]);
  const L = idx[idx.length - 1];
  for (let j = 0; j < segs; j++) B.t(bot, L[(j + 1) % segs], L[j]);
  return B.done();
}

function addBox(B, c, ax, ay, az) {
  const P = [];
  for (const sz of [-1, 1]) for (const sy of [-1, 1]) for (const sx of [-1, 1]) {
    P.push(B.p(c[0] + sx * ax[0] + sy * ay[0] + sz * az[0], c[1] + sx * ax[1] + sy * ay[1] + sz * az[1], c[2] + sx * ax[2] + sy * ay[2] + sz * az[2]));
  }
  const [p0, p1, p2, p3, p4, p5, p6, p7] = P;
  B.q(p0, p2, p3, p1); B.q(p4, p5, p7, p6); B.q(p0, p1, p5, p4); B.q(p2, p6, p7, p3); B.q(p0, p4, p6, p2); B.q(p1, p3, p7, p5);
}

export function box(a, b, c) {
  const B = builder();
  addBox(B, [0, 0, 0], [a / 2, 0, 0], [0, b / 2, 0], [0, 0, c / 2]);
  return B.done();
}

function addCylinderX(B, r, x0, x1, seg) {
  const a = [], b = [];
  for (let j = 0; j < seg; j++) { const t = 2 * Math.PI * j / seg; a.push(B.p(x0, r * Math.cos(t), r * Math.sin(t))); b.push(B.p(x1, r * Math.cos(t), r * Math.sin(t))); }
  const ca = B.p(x0, 0, 0), cb = B.p(x1, 0, 0);
  for (let j = 0; j < seg; j++) {
    const k = (j + 1) % seg;
    B.q(a[j], a[k], b[k], b[j]); B.t(ca, a[k], a[j]); B.t(cb, b[j], b[k]);
  }
}

export function rotor(opt = {}) {
  const R = opt.R ?? 400, n = opt.blades ?? 3, hub = opt.hub ?? 0.18 * R, chord = opt.chord ?? 0.28 * R;
  const thick = opt.thick ?? 0.04 * R, pitch = (opt.pitch ?? 30) * Math.PI / 180, twist = (opt.twist ?? 15) * Math.PI / 180;
  const B = builder(), seg = 4;
  addCylinderX(B, hub, -0.6 * hub, 0.6 * hub, 20);
  for (let b = 0; b < n; b++) {
    const ph = 2 * Math.PI * b / n + (opt.phase ?? 0) * Math.PI / 180;
    for (let s = 0; s < seg; s++) {
      const r0 = hub * 0.8 + (R - hub * 0.8) * s / seg, r1 = hub * 0.8 + (R - hub * 0.8) * (s + 1) / seg, rm = (r0 + r1) / 2;
      const ang = pitch + twist * (0.5 - (rm - hub) / (R - hub)), cw = chord * (1 - 0.35 * (rm - hub) / (R - hub));
      const er = [0, Math.cos(ph), Math.sin(ph)], et = [0, -Math.sin(ph), Math.cos(ph)];
      const ec = [Math.sin(ang), et[1] * Math.cos(ang), et[2] * Math.cos(ang)], en = [Math.cos(ang), -et[1] * Math.sin(ang), -et[2] * Math.sin(ang)];
      const c = [0, er[1] * rm, er[2] * rm], hr = (r1 - r0) / 2 * 1.02;
      addBox(B, c, er.map((x) => x * hr), ec.map((x) => x * cw / 2), en.map((x) => x * thick / 2));
    }
  }
  return B.done();
}

export function tube(ri, ro, len, seg = 48) {
  const B = builder(), x0 = -len / 2, x1 = len / 2, P = [];
  for (const [r, x] of [[ro, x0], [ro, x1], [ri, x1], [ri, x0]]) {
    const ring = [];
    for (let j = 0; j < seg; j++) { const t = 2 * Math.PI * j / seg; ring.push(B.p(x, r * Math.cos(t), r * Math.sin(t))); }
    P.push(ring);
  }
  for (let j = 0; j < seg; j++) {
    const k = (j + 1) % seg;
    B.q(P[0][j], P[0][k], P[1][k], P[1][j]);
    B.q(P[1][j], P[1][k], P[2][k], P[2][j]);
    B.q(P[2][j], P[2][k], P[3][k], P[3][j]);
    B.q(P[3][j], P[3][k], P[0][k], P[0][j]);
  }
  return B.done();
}

export function terrainHeight(gen, x, y) {
  let h = +gen.base || 0;
  for (const [hx, hy, hh, r] of gen.hills || []) h += hh * Math.exp(-((x - hx) ** 2 + (y - hy) ** 2) / (2 * r * r));
  return h;
}

export function terrain(gen) {
  const B = builder(), nx = gen.nx ?? 64, ny = gen.ny ?? 64, w = gen.w, d = gen.d, zb = gen.bottom ?? -2000, top = [], bot = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const x = -w / 2 + w * i / nx, y = -d / 2 + d * j / ny;
    top.push(B.p(x, y, terrainHeight(gen, x, y)));
  }
  const id = (i, j) => j * (nx + 1) + i;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) B.q(top[id(i, j)], top[id(i + 1, j)], top[id(i + 1, j + 1)], top[id(i, j + 1)]);
  const ring = [];
  for (let i = 0; i < nx; i++) ring.push([i, 0]);
  for (let j = 0; j < ny; j++) ring.push([nx, j]);
  for (let i = nx; i > 0; i--) ring.push([i, ny]);
  for (let j = ny; j > 0; j--) ring.push([0, j]);
  for (const [i, j] of ring) { const x = -w / 2 + w * i / nx, y = -d / 2 + d * j / ny; bot.push(B.p(x, y, zb)); }
  const c = B.p(0, 0, zb), n = ring.length;
  for (let k = 0; k < n; k++) {
    const a = ring[k], b = ring[(k + 1) % n];
    B.q(top[id(b[0], b[1])], top[id(a[0], a[1])], bot[k], bot[(k + 1) % n]);
    B.t(c, bot[(k + 1) % n], bot[k]);
  }
  return B.done();
}

export function generate(gen) {
  if (gen.type === 'terrain') return terrain(gen);
  if (gen.type === 'tube') return tube(gen.ri, gen.ro, gen.len, gen.seg ?? 48);
  if (gen.type === 'sphere') return sphere(gen.r, gen.seg ?? 24);
  if (gen.type === 'box') return box(gen.a, gen.b, gen.c);
  if (gen.type === 'rotor') return rotor(gen);
  throw new Error(`알 수 없는 형상 생성기: ${gen.type}`);
}
