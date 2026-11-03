import { lut } from './lbm/render.js';
import { streamlines } from './lbm/flowviz.js';

const $ = (id) => document.getElementById(id);
const THEME_NEXT = { system: 'dark', dark: 'light', light: 'system' }, THEME_LABEL = { system: '◐', dark: '☾', light: '☀' };
let theme = 'system', R = null;
const css = (n) => getComputedStyle(document.body).getPropertyValue(n).trim();
const f3 = (v, d = 3) => (Number.isFinite(v) ? (+v.toFixed(d)).toString() : '–');
const pct = (a, b) => (100 * (a - b) / b);
const grade = (e) => (Math.abs(e) <= 3 ? 'ok' : Math.abs(e) <= 20 ? 'mid' : 'bad');

function applyTheme() {
  const light = theme === 'light' || (theme === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  $('btnTheme').textContent = THEME_LABEL[theme];
  if (R) render();
}

function chart(box, o) {
  const W = 520, H = 330, m = { l: 54, r: 14, t: 12, b: 42 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const all = o.series.flatMap((s) => s.pts.filter((p) => p[1] !== null && Number.isFinite(p[1])));
  let [x0, x1] = o.xlim || [Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[0]))];
  let [y0, y1] = o.ylim || [Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[1]))];
  if (!o.ylim) { const pad = (y1 - y0) * 0.06 || 1; y0 -= pad; y1 += pad; }
  const lx = o.logx, X = (v) => m.l + (lx ? Math.log10(v / x0) / Math.log10(x1 / x0) : (v - x0) / (x1 - x0)) * iw, Y = (v) => m.t + (1 - (v - y0) / (y1 - y0)) * ih;
  const ticks = (a, b, n, log) => { if (log) { const t = []; for (let e = Math.floor(Math.log10(a)); e <= Math.ceil(Math.log10(b)); e++) for (const k of [1, 2, 5]) { const v = k * 10 ** e; if (v >= a * 0.999 && v <= b * 1.001) t.push(v); } return t; } const st = niceStep((b - a) / n), t = []; for (let v = Math.ceil(a / st) * st; v <= b + st * 1e-6; v += st) t.push(+v.toFixed(10)); return t; };
  const ink = css('--muted'), grid = css('--chart-grid'), txt = css('--text');
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${o.title}">`;
  for (const t of ticks(y0, y1, 5)) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(t)}" y2="${Y(t)}" stroke="${grid}" stroke-width="1"/><text x="${m.l - 6}" y="${Y(t) + 4}" font-size="11" text-anchor="end" fill="${ink}">${+t.toPrecision(4)}</text>`;
  for (const t of ticks(x0, x1, 6, lx)) s += `<line x1="${X(t)}" x2="${X(t)}" y1="${m.t}" y2="${H - m.b}" stroke="${grid}" stroke-width="1" opacity="0.6"/><text x="${X(t)}" y="${H - m.b + 16}" font-size="11" text-anchor="middle" fill="${ink}">${+t.toPrecision(4)}</text>`;
  if (y0 < 0 && y1 > 0) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(0)}" y2="${Y(0)}" stroke="${ink}" stroke-width="1" opacity="0.5"/>`;
  s += `<text x="${m.l + iw / 2}" y="${H - 6}" font-size="12" text-anchor="middle" fill="${txt}">${o.xlabel}</text>`;
  s += `<text x="14" y="${m.t + ih / 2}" font-size="12" text-anchor="middle" fill="${txt}" transform="rotate(-90 14 ${m.t + ih / 2})">${o.ylabel}</text>`;
  for (const se of o.series) {
    const col = css(se.color);
    if (se.kind === 'line') {
      let d = '', on = false;
      for (const [x, y] of se.pts) { if (y === null || !Number.isFinite(y)) { on = false; continue; } d += `${on ? 'L' : 'M'}${X(x).toFixed(1)},${Y(y).toFixed(1)}`; on = true; }
      s += `<path d="${d}" fill="none" stroke="${col}" stroke-width="2" ${se.dash ? 'stroke-dasharray="5 4"' : ''} stroke-linejoin="round"/>`;
    } else for (const [x, y] of se.pts) if (y !== null && Number.isFinite(y)) s += `<circle cx="${X(x)}" cy="${Y(y)}" r="${se.r || 4.5}" fill="${se.hollow ? css('--chart-bg') : col}" stroke="${se.hollow ? col : css('--chart-bg')}" stroke-width="2"/>`;
  }
  s += `<rect class="hit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent"/></svg>`;
  box.innerHTML = `<div class="vt">${o.title}</div>${s}<div class="vleg">${o.series.map((se) => `<span><i class="${se.kind === 'line' ? '' : 'dot'}" style="background:${css(se.color)}"></i>${se.name}</span>`).join('')}</div>`;
  const svg = box.querySelector('svg'), tip = $('tip');
  svg.addEventListener('mousemove', (ev) => {
    const r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) / r.width * W, py = (ev.clientY - r.top) / r.height * H;
    let best = null, bd = 900;
    for (const se of o.series) for (const p of se.pts) { if (p[1] === null || !Number.isFinite(p[1])) continue; const d = (X(p[0]) - px) ** 2 + (Y(p[1]) - py) ** 2; if (d < bd) { bd = d; best = [se, p]; } }
    if (!best) { tip.classList.add('hidden'); return; }
    tip.innerHTML = `${best[0].name}<br>${o.xlabel.split(' ')[0]} = ${f3(best[1][0], 4)} · ${o.ylabel.split(' ')[0]} = ${f3(best[1][1], 4)}`;
    tip.style.left = `${ev.clientX + 12}px`; tip.style.top = `${ev.clientY + 12}px`; tip.classList.remove('hidden');
  });
  svg.addEventListener('mouseleave', () => tip.classList.add('hidden'));
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1)), n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}

function fieldImage(box, title, nx, ny, val, opts = {}) {
  const L = lut('umag'), sc = Math.max(1, Math.floor(560 / nx)), cv = document.createElement('canvas');
  cv.width = nx * sc; cv.height = ny * sc;
  const g = cv.getContext('2d'), img = g.createImageData(nx, ny), vmax = opts.vmax || Math.max(...val.filter((v) => v !== null));
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v = val[j * nx + i], o = 4 * ((ny - 1 - j) * nx + i);
    const c = v === null ? [110, 114, 124] : L[Math.max(0, Math.min(L.length - 1, Math.round(v / vmax * (L.length - 1))))];
    img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
  }
  const tmp = document.createElement('canvas'); tmp.width = nx; tmp.height = ny; tmp.getContext('2d').putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true; g.drawImage(tmp, 0, 0, nx * sc, ny * sc);
  if (opts.lines) {
    g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 1.2;
    for (const ln of opts.lines) { g.beginPath(); ln.forEach(([x, y], k) => { const X = x * sc, Y = (ny - y) * sc; k ? g.lineTo(X, Y) : g.moveTo(X, Y); }); g.stroke(); }
  }
  for (const mk of opts.marks || []) {
    g.beginPath(); g.arc(mk.x * nx * sc, (1 - mk.y) * ny * sc, 6, 0, 7);
    g.fillStyle = mk.color; g.fill(); g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
  }
  box.innerHTML = `<div class="vt">${title}</div>`;
  box.appendChild(cv);
  if (opts.legend) { const d = document.createElement('div'); d.className = 'vleg'; d.innerHTML = opts.legend; box.appendChild(d); }
}

function vcase(id, title, desc) {
  const el = document.createElement('div');
  el.className = 'vcase'; el.id = id;
  el.innerHTML = `<h3>${title}</h3><p class="desc">${desc}</p><div class="vgrid"></div><div class="metrics"></div>`;
  $('vcharts').appendChild(el);
  const grid = el.querySelector('.vgrid'), add = () => { const b = document.createElement('div'); b.className = 'vbox'; grid.appendChild(b); return b; };
  const metric = (label, val, ref, e) => { el.querySelector('.metrics').insertAdjacentHTML('beforeend', `<div class="metric">${label}<b>${val}</b><small>기준 ${ref}${e !== undefined ? ` · <span class="${grade(e)}">${e >= 0 ? '+' : ''}${e.toFixed(1)}%</span>` : ''}</small></div>`); };
  return { add, metric };
}

function render() {
  $('vcharts').innerHTML = '';
  const rows = [];
  const S1 = '--ser1', S2 = '--ser2', S3 = '--ser3';
  const p = R['2d_poiseuille'];
  if (p) {
    const c = vcase('v-pois', '2D-1 평행판 사이 층류 (Poiseuille), Re = 20', `입구 균일 유속, 출구 압력. 완전 발달 구간(x = 0.7L)의 속도 분포와 압력 구배를 해석해 \\(u/\\bar u = 6\\eta(1-\\eta)\\), \\(dp/dx = -12\\mu\\bar u/H^2\\)와 비교. 격자 ${p.grid.join('×')}, 채널 폭 ${p.grid[1] - 2}셀.`);
    chart(c.add(), { title: '속도 분포 u/ū (x = 0.7L)', xlabel: 'y/H', ylabel: 'u/ū', series: [{ name: '해석해', kind: 'line', color: S2, pts: p.ana }, { name: 'LBM', kind: 'dots', color: S1, pts: p.prof, r: 3.5 }], xlim: [0, 1] });
    const e = pct(p.dpdx, p.dpRef);
    c.metric('속도 분포 RMS 오차', `${(100 * p.err).toFixed(2)}%`, '해석해 포물선');
    c.metric('압력 구배 dp/dx', f3(p.dpdx / p.dpRef, 4), '1 (해석해 비)', e);
    rows.push(['2D', '평행판 층류 Re 20', '속도 분포 RMS / dp/dx', `${(100 * p.err).toFixed(2)}% / ${e >= 0 ? '+' : ''}${e.toFixed(1)}%`, Math.max(100 * p.err, Math.abs(e))]);
  }
  for (const Re of [100, 1000]) {
    const d = R[`2d_cavity_${Re}`];
    if (!d) continue;
    const c = vcase(`v-cav${Re}`, `2D-${Re === 100 ? 2 : '2b'} 덮개 구동 정사각 캐비티, Re = ${Re}`, `윗변이 속도 U로 움직이는 정사각 공동. 중심선 속도를 Ghia et al.(1982)의 표와 비교. 격자 ${d.N}×${d.N}, ${d.steps.toLocaleString()} 스텝.`);
    chart(c.add(), { title: '수직 중심선 u/U (x = 0.5)', xlabel: 'y/L', ylabel: 'u/U', series: [{ name: 'LBM', kind: 'line', color: S1, pts: d.u }, { name: 'Ghia et al. (1982)', kind: 'dots', color: S2, pts: d.ref.u }], xlim: [0, 1] });
    chart(c.add(), { title: '수평 중심선 v/U (y = 0.5)', xlabel: 'x/L', ylabel: 'v/U', series: [{ name: 'LBM', kind: 'line', color: S1, pts: d.v }, { name: 'Ghia et al. (1982)', kind: 'dots', color: S2, pts: d.ref.v }], xlim: [0, 1] });
    if (d.field) {
      const n = d.field.n, ux = new Float32Array(n * n), uy = new Float32Array(n * n), sp = [];
      d.field.uv.forEach(([a, b], k) => { ux[k] = a; uy[k] = b; sp.push(Math.hypot(a, b)); });
      const lines = streamlines(ux, uy, new Uint8Array(n * n), n, n, 2);
      fieldImage(c.add(), '속도 크기 |u|/U와 유선 (LBM)', n, n, sp, { vmax: 1, lines, marks: [{ x: d.vortex[0], y: d.vortex[1], color: css(S1) }, { x: d.ref.vortex[0], y: d.ref.vortex[1], color: css(S2) }], legend: `<span><i class="dot" style="background:${css(S1)}"></i>주 와류 중심 LBM (${f3(d.vortex[0])}, ${f3(d.vortex[1])})</span><span><i class="dot" style="background:${css(S2)}"></i>Ghia (${d.ref.vortex.join(', ')})</span>` });
    }
    const ev = Math.hypot(d.vortex[0] - d.ref.vortex[0], d.vortex[1] - d.ref.vortex[1]) * 100;
    c.metric('u 중심선 RMS 오차', `${(100 * d.errU).toFixed(2)}%`, 'Ghia 17점');
    c.metric('v 중심선 RMS 오차', `${(100 * d.errV).toFixed(2)}%`, 'Ghia 17점');
    c.metric('와류 중심 위치 차이', `${ev.toFixed(2)}% L`, `(${d.ref.vortex.join(', ')})`);
    rows.push(['2D', `캐비티 Re ${Re}`, '중심선 u / v RMS', `${(100 * d.errU).toFixed(2)}% / ${(100 * d.errV).toFixed(2)}%`, 100 * Math.max(d.errU, d.errV)]);
  }
  const cy = R['2d_cylinder'];
  if (cy) {
    const c = vcase('v-cyl', '2D-3 원기둥 주위 흐름 (카르만 와열), Re = 100', `D = ${cy.D}셀, 도메인 ${cy.grid[0] / cy.D}D × ${Math.round(cy.grid[1] / cy.D)}D (막힘비 ${(100 * cy.D / cy.grid[1]).toFixed(0)}%), 미끄럼 측벽. 항력·양력 계수와 스트로할 수를 비구속 원기둥 문헌값(Park et al. 1998, Williamson)과 비교. 막힘비(측벽 가속)와 지름 20셀 해상도(경계층 약 2셀) 때문에 C<sub>d</sub>·C<sub>l</sub>이 높게 나옵니다. 주기(St)는 해상도에 덜 민감합니다.`);
    const h = cy.hist.slice(Math.floor(cy.hist.length * 0.12)), t0 = h[0][0];
    chart(c.add(), { title: '항력·양력 계수 시계열', xlabel: 't [s]', ylabel: 'C', series: [{ name: 'C_d (LBM)', kind: 'line', color: S1, pts: h.map((r) => [r[0] - t0, r[1]]) }, { name: 'C_l (LBM)', kind: 'line', color: S3, pts: h.map((r) => [r[0] - t0, r[2]]) }, { name: `C_d 문헌 ${cy.ref.cd}`, kind: 'line', color: S2, dash: true, pts: [[0, cy.ref.cd], [h.at(-1)[0] - t0, cy.ref.cd]] }] });
    if (cy.field) fieldImage(c.add(), '순간 속도 크기 |u|/U (LBM)', cy.field.nx, cy.field.ny, cy.field.umag, { vmax: 1.5 });
    const e1 = pct(cy.cd, cy.ref.cd), e2 = pct(cy.St, cy.ref.St), e3 = pct(cy.clAmp, cy.ref.clAmp);
    const hw = R['2d_cylinder_hw'];
    c.metric('평균 항력계수 C_d', f3(cy.cd), `${cy.ref.cd}${hw ? ` · 이전 ${f3(hw.cd)}` : ''}`, e1);
    c.metric('스트로할 수 St', f3(cy.St), cy.ref.St, e2);
    c.metric('양력 진폭 C_l', f3(cy.clAmp), `${cy.ref.clAmp}${hw ? ` · 이전 ${f3(hw.clAmp)}` : ''}`, e3);
    rows.push(['2D', '원기둥 Re 100', 'C_d / St / C_l', `${e1 >= 0 ? '+' : ''}${e1.toFixed(1)}% / ${e2 >= 0 ? '+' : ''}${e2.toFixed(1)}% / ${e3 >= 0 ? '+' : ''}${e3.toFixed(1)}%`, Math.max(Math.abs(e1), Math.abs(e2), Math.abs(e3))]);
  }
  for (const [key, name, label] of [['3d_duct', '3D-1 정사각 덕트 완전 발달 층류, Re = 40', '정사각 덕트'], ['3d_pipe', '3D-2 원관 Hagen–Poiseuille 유동, Re = 40', '원관']]) {
    const d = R[key];
    if (!d) continue;
    const isPipe = key === '3d_pipe';
    const c = vcase(isPipe ? 'v-pipe' : 'v-duct', name, isPipe ? `정육면체 격자 안에 원형 관(지름 18셀)을 복셀화해 넣은 경우. 계단 모양 벽의 영향을 보는 시험입니다. 해석해 \\(u/\\bar u = 2(1-r^2/R^2)\\), \\(f\\,Re = 64\\). 격자 ${d.grid.join('×')}.` : `도메인 측면 4개를 벽으로 둔 정사각 덕트(한 변 20셀). 해석해는 Fourier 급수해(Shah & London), \\(f\\,Re = 56.91\\), \\(u_{max}/\\bar u = 2.096\\). 격자 ${d.grid.join('×')}.`);
    chart(c.add(), { title: '중심선 속도 분포 u/ū (z = 중앙, x = 0.75L)', xlabel: 'y/W', ylabel: 'u/ū', series: [{ name: isPipe ? '해석해 (포물선)' : '해석해 (급수해)', kind: 'line', color: S2, pts: d.ana }, { name: 'LBM', kind: 'dots', color: S1, pts: d.prof.filter((q) => q[1] !== null), r: 3.5 }], xlim: [0, 1] });
    const e1 = pct(d.fRe, d.ref.fRe), e2 = pct(d.umax, d.ref.umax);
    c.metric('마찰계수 f·Re', f3(d.fRe, 2), d.ref.fRe, e1);
    c.metric('최대/평균 속도비', f3(d.umax), d.ref.umax, e2);
    rows.push(['3D', `${label} Re 40`, 'f·Re / u_max/ū', `${e1 >= 0 ? '+' : ''}${e1.toFixed(1)}% / ${e2 >= 0 ? '+' : ''}${e2.toFixed(1)}%`, Math.max(Math.abs(e1), Math.abs(e2))]);
  }
  const sph = Object.keys(R).filter((k) => /^3d_sphere_\d+$/.test(k)).map((k) => R[k]).sort((a, b) => a.Re - b.Re);
  const sphHw = Object.keys(R).filter((k) => /^3d_sphere_\d+_hw$/.test(k)).map((k) => R[k]).sort((a, b) => a.Re - b.Re);
  if (sph.length) {
    const c = vcase('v-sph', '3D-3 구 주위 흐름: 항력계수 C_d(Re)', `D = ${sph[0].D}셀, 도메인 15D × 6D × 6D (막힘비 2%), 미끄럼 측벽. Schiller–Naumann 경험식 \\(C_d = \\tfrac{24}{Re}(1+0.15Re^{0.687})\\)과 비교.`);
    const curve = []; for (let lr = 1; lr <= 2.6; lr += 0.02) { const Re = 10 ** lr; curve.push([Re, 24 / Re * (1 + 0.15 * Re ** 0.687)]); }
    chart(c.add(), { title: '항력계수 C_d vs Re', xlabel: 'Re', ylabel: 'C_d', logx: true, xlim: [10, 400], series: [{ name: 'Schiller–Naumann', kind: 'line', color: S2, pts: curve }, { name: 'LBM 보간 bounce-back', kind: 'dots', color: S1, pts: sph.map((s) => [s.Re, s.cd]), r: 6 }, ...(sphHw.length ? [{ name: '이전 halfway bounce-back', kind: 'dots', color: S3, hollow: true, pts: sphHw.map((s) => [s.Re, s.cd]), r: 5 }] : [])] });
    const last = sph.find((s) => s.Re === 100) || sph[0];
    chart(c.add(), { title: `C_d 수렴 이력 (Re = ${last.Re})`, xlabel: 'step', ylabel: 'C_d', series: [{ name: 'LBM', kind: 'line', color: S1, pts: last.hist }, { name: 'Schiller–Naumann', kind: 'line', color: S2, dash: true, pts: [[last.hist[0][0], last.sn], [last.hist.at(-1)[0], last.sn]] }] });
    for (const s of sph) { const hw = sphHw.find((h) => h.Re === s.Re); c.metric(`C_d, Re = ${s.Re}`, f3(s.cd), `${f3(s.sn)}${hw ? ` · 이전 ${hw.cd >= s.sn ? '+' : ''}${pct(hw.cd, s.sn).toFixed(0)}%` : ''}`, pct(s.cd, s.sn)); }
    rows.push(['3D', `구 Re ${sph.map((s) => s.Re).join(', ')}`, 'C_d', sph.map((s) => `${pct(s.cd, s.sn) >= 0 ? '+' : ''}${pct(s.cd, s.sn).toFixed(1)}%`).join(' / '), Math.max(...sph.map((s) => Math.abs(pct(s.cd, s.sn))))]);
  }
  $('vsummary').innerHTML = `<table class="tbl" id="v-summary"><tr><th>차원</th><th>케이스</th><th>비교 항목</th><th>오차</th><th>정합도</th><th>판정</th></tr>${rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td class="vnum">${r[3]}</td><td class="vnum">${(100 - Math.abs(r[4])).toFixed(1)}%</td><td class="${grade(r[4])}">${Math.abs(r[4]) <= 3 ? '양호 (≥97%)' : Math.abs(r[4]) <= 10 ? '보통 (≥90%)' : Math.abs(r[4]) <= 20 ? '사용 가능 (≥80%)' : '개선 필요 (<80%)'}</td></tr>`).join('')}</table>`;
  if (window.renderMathInElement) renderMathInElement($('vcharts'), { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '\\(', right: '\\)', display: false }] });
}

async function init() {
  try { theme = localStorage.getItem('lbm-theme') || 'system'; } catch (_) {}
  $('btnTheme').onclick = () => { theme = THEME_NEXT[theme]; try { localStorage.setItem('lbm-theme', theme); } catch (_) {} applyTheme(); };
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (theme === 'system') applyTheme(); });
  applyTheme();
  if (window.renderMathInElement) renderMathInElement(document.querySelector('.tmain'), { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '\\(', right: '\\)', display: false }] });
  try { R = await (await fetch('validation/results.json')).json(); render(); }
  catch (e) { $('vcharts').innerHTML = `<div class="pending">검증 결과 파일을 불러오지 못했습니다: ${e.message}</div>`; }
}
init();
