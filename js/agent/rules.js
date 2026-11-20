const NUM = '([-+]?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?)';
const re = (s, f = '') => new RegExp(s, f);
const FACES3 = ['xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax'];
const EDGE_OF = { xmin: 'left', xmax: 'right', ymin: 'bottom', ymax: 'top' };
const FACE_KO = { xmin: 'x 최소', xmax: 'x 최대', ymin: 'y 최소', ymax: 'y 최대', zmin: 'z 최소(바닥)', zmax: 'z 최대(천장)' };
const EDGE_KO = { left: '왼쪽', right: '오른쪽', bottom: '아래', top: '위' };
const TYPE_KO = { velocity: '속도 유입', pressure: '압력', outflow: '자유 유출', wall: '벽', slip: '미끄럼벽', periodic: '주기' };
const TERRAIN = [
  [/도심|도시|시가지|빌딩\s*숲|urban|city/, '도시', 0.30, 1000],
  [/교외|주거|주택가|suburb/, '교외', 0.22, 300],
  [/개활지|평지|들판|초원|open\s*(?:country|terrain)/, '개활지', 0.14, 30],
  [/해상|바다|해안|호수|수면|sea|coast/, '해상', 0.11, 2],
];

const FILLER = [
  '해\\s*주세요', '해\\s*주십시오', '해\\s*줘요', '해\\s*줘', '해\\s*봐', '해\\s*라', '해\\s*요', '합니다', '한다', '하자', '할게', '할래', '하고', '해서', '하면', '하여', '하는', '한\\s*뒤', '한\\s*다음', '한\\s*후', '해(?![가-힣])',
  '주세요', '줘요', '줘라', '줘', '주고', '줄래', '주자', '넣어', '넣고', '적용', '추가', '설정', '지정', '입력', '부여', '만들어', '만들고', '바꿔', '바꾸고', '변경', '수정', '두고', '둬', '놔', '놓고', '놓아', '걸어', '걸고',
  '으로', '에서', '에다가', '에다', '에게', '부터', '까지', '이며', '이고', '이다', '입니다', '이야', '인데', '라고', '하게', '되게', '되도록', '하도록', '로서', '로써',
  '좀', '이제', '우선', '먼저', '다음', '그다음', '그리고', '또한', '또', '그냥', '다시', '한번', '각각', '모두', '전부', '전체', '모든', '값', '만큼', '정도', '짜리', '약', '대략', '쯤', '가량', '현재', '지금', '새로', '새',
  '방향', '쪽', '측', '바람', '불어', '불게', '불도록', '유속', '풍속', '속도', '흘려', '흐르게', '지형', '분포', '프로파일', '정도로', '으로는', '에는', '면', '변', '부분', '곳', '것', '거', '걸', '게', '수', '때', '중', '조건', '경계', '경계조건', '해석', '모델', '시뮬레이션', '계산', '값을', '크기', '유체', '흐름', '유동', '도메인', '영역', '하나', '한\\s*개', '개',
  'please', 'set', 'add', 'make', 'put', 'use', 'with', 'the', 'an', 'to', 'at', 'on', 'of', 'in', 'by', 'is', 'as', 'it', 'and', 'then', 'for', 'from', 'a', 'side', 'face', 'value', 'condition', 'boundary',
  '불고', '불어서', '추가하고', '하', '불', '되', '돼', '을', '를', '이', '가', '은', '는', '에', '의', '로', '도', '만', '과', '와', '랑', '및', '인', '임', '함', '들', '요', '야', '다', '고', '게', '서', '께',
].join('|');

class Clause {
  constructor(text) { this.raw = text; this.w = text.toLowerCase(); }
  take(p) { const m = this.w.match(p); if (m) this.w = this.w.slice(0, m.index) + ' '.repeat(m[0].length) + this.w.slice(m.index + m[0].length); return m; }
  takeAll(p) { const out = []; for (let m; (m = this.take(p));) out.push(m); return out; }
  has(p) { return p.test(this.w); }
  leftover() {
    let s = this.w.replace(/[\s.,!?~:;()[\]"'`·\-+=/\\*_<>→←^#@&|{}\x01%]+/g, ' ');
    const fr = re(`(?<![a-z가-힣])(?:${FILLER})(?![a-z])`, 'g');
    for (let prev = null; prev !== s;) { prev = s; s = s.replace(fr, ' ').replace(re(`(?<=[가-힣])(?:${FILLER})(?=\\s|$)`, 'g'), ' '); }
    return s.split(/\s+/).filter((t) => t && (/\d/.test(t) || /[가-힣]/.test(t) || /[a-z]{2,}/.test(t)));
  }
}

export function splitClauses(text) {
  let t = String(text).replace(/[−–]/g, '-').replace(/×/g, 'x').replace(/，/g, ',').replace(/℃/g, '°c');
  t = t.replace(/(?<=\d),(?=\d{3}(?!\d))/g, '').replace(/,\s*(?=(?:기준\s*높이|z_?ref|α|alpha|알파|z0|z₀|조도\s*길이))/g, ' ');
  t = t.replace(/[([]([^()[\]]*)[)\]]/g, (_, a) => `(${a.replace(/,/g, '\x01')})`);
  t = t.replace(/(\d)\s*,\s*(?=[-+]?\d)/g, '$1\x01');
  t = t.replace(/(?<![a-z])([xyz])\s*,\s*(?=[xyz](?![a-z]))/gi, '$1\x01');
  const parts = t.split(/[\n;]|,|(?<!\d)\.(?!\d)|\s그리고\s|\s또한\s|\s또\s|\sand then\s|\sthen\s|(?<=(?:하고|주고|넣고|두고|켜고|끄고|놓고|잡고|바꾸고|만들고|옮기고|돌리고|걸고|키우고|줄이고|지우고|붙이고|맞추고|불러오고|추가하고|설정하고|적용하고|변경하고|불고|흐르고|흘리고|이고|이며|하며))\s+|(?<=[가-힣]고)\s+(?=\S+(?:은|는)\s)|\s(?:한\s*뒤|한\s*후|한\s*다음에?|하고\s*나서)\s/);
  return parts.map((s) => (s || '').replace(/\x01/g, ',').trim()).filter((s) => s && !/^(그리고|또|and)$/.test(s));
}

const f = (s) => parseFloat(s);

function speedOf(c) {
  let m;
  if ((m = c.take(re(`(?:시속|時速)\\s*${NUM}\\s*(?:km|킬로)(?:\\s*(?:/\\s*h|미터))?`)))) return f(m[1]) / 3.6;
  if ((m = c.take(re(`(?:초속|秒速)\\s*${NUM}\\s*(?:m|미터)?`)))) return f(m[1]);
  if ((m = c.take(re(`${NUM}\\s*(?:m\\s*/\\s*s|m/sec|㎧|mps|미터\\s*(?:퍼|毎)\\s*초|미터\\s*매\\s*초)`)))) return f(m[1]);
  if ((m = c.take(re(`${NUM}\\s*(?:km\\s*/\\s*h|kph|km/hr|킬로미터\\s*퍼\\s*시|키로|km\\s*per\\s*h)`)))) return f(m[1]) / 3.6;
  if ((m = c.take(re(`${NUM}\\s*(?:cm\\s*/\\s*s)`)))) return f(m[1]) / 100;
  if ((m = c.take(re(`${NUM}\\s*(?:mm\\s*/\\s*s)`)))) return f(m[1]) / 1000;
  return null;
}

function pressureOf(c) {
  const U = [['kpa|킬로\\s*파스칼', 1e3], ['hpa|헥토\\s*파스칼', 100], ['mpa|메가\\s*파스칼', 1e6], ['pa(?![a-z])|파스칼', 1], ['bar(?![a-z])', 1e5], ['mbar', 100], ['atm|기압', 101325], ['mmaq|mmh2o|수주', 9.80665]];
  for (const [u, k] of U) { const m = c.take(re(`${NUM}\\s*(?:${u})`)); if (m) return f(m[1]) * k; }
  if (c.take(/대기압|atmospheric/)) return 0;
  return null;
}

function lengthOf(c, label = '') {
  const U = [['mm|밀리(?:미터)?', 1], ['cm|센티(?:미터)?', 10], ['km|킬로미터', 1e6], ['m(?![a-z/²³0-9])|미터', 1000], ['inch|인치', 25.4]];
  for (const [u, k] of U) { const m = c.take(re(`${label}${NUM}\\s*(?:${u})`)); if (m) return f(m[1]) * k; }
  return null;
}

function timeOf(c) {
  let m;
  if ((m = c.take(re(`${NUM}\\s*(?:ms|밀리\\s*초)`)))) return f(m[1]) / 1000;
  if ((m = c.take(re(`${NUM}\\s*(?:s(?![a-z])|sec|초(?!속))`)))) return f(m[1]);
  if ((m = c.take(re(`${NUM}\\s*(?:min|분(?![할포석]))`)))) return f(m[1]) * 60;
  return null;
}

function vectorOf(c, n) {
  const m = c.take(re(`\\(\\s*${NUM}\\s*[,\\s]\\s*${NUM}${n === 3 ? `\\s*[,\\s]\\s*${NUM}` : ''}\\s*\\)\\s*(mm|cm|m(?![a-z/]))?`));
  if (!m) return null;
  const k = { mm: 1, cm: 10, m: 1000 }[m[n + 1]] || 1;
  return m.slice(1, n + 1).map((v) => f(v) * k);
}

function sizeOf(c, n) {
  const m = c.take(re(`${NUM}\\s*(mm|cm|m(?![a-z/]))?\\s*[x*]\\s*${NUM}\\s*(mm|cm|m(?![a-z/]))?${n === 3 ? `\\s*[x*]\\s*${NUM}` : ''}\\s*(mm|cm|m(?![a-z/]))?`));
  if (!m) return null;
  const vals = n === 3 ? [m[1], m[3], m[5]] : [m[1], m[3]], units = n === 3 ? [m[2], m[4], m[6]] : [m[2], m[4]];
  const last = units.filter(Boolean).pop();
  const k = (u) => ({ mm: 1, cm: 10, m: 1000 }[u || last] || 0);
  const out = vals.map((v, i) => f(v) * (k(units[i]) || 1));
  const unitless = !last;
  return { v: unitless && out.every((x) => x < 200) ? out.map((x) => x * 1000) : out, guessed: unitless && out.every((x) => x < 200) };
}

function dirOf(c) {
  const m = c.take(/([+-])?\s*([xyz])\s*(?:축)?\s*(?:\(?\s*([+-])\s*\)?)?\s*(?:방향|쪽으로|으로\s*(?:불|흐)|direction)/);
  if (!m) return null;
  const s = (m[1] || m[3]) === '-' ? -1 : 1;
  return { axis: 'xyz'.indexOf(m[2]), sign: s };
}

function facesOf(c, dim, ctx) {
  const out = new Set();
  const add = (k) => { if (dim === 2 && !EDGE_OF[k]) return; out.add(k); };
  let m;
  while ((m = c.take(/(?:([+-])\s*([xyz])|([xyz])\s*([+-])(?![\d.])|([xyz])\s*(?:최소|min|하한|시작|=\s*0(?![.\d])|0\s*쪽)|([xyz])\s*(?:최대|max|상한|끝))\s*(?:면|변|경계|쪽|측)?/))) {
    if (m[2] || m[3]) add(`${m[2] || m[3]}${(m[1] || m[4]) === '-' ? 'min' : 'max'}`);
    else if (m[5]) add(`${m[5]}min`); else if (m[6]) add(`${m[6]}max`);
  }
  if (c.take(/(?:모든|전체|모두|사방|4|6)\s*(?:면|변|경계)|all\s*(?:faces|sides)/)) for (const k of FACES3) add(k);
  if (c.take(/나머지\s*(?:면|변|경계)?/)) for (const k of FACES3) if (!(ctx.used || new Set()).has(k)) add(k);
  if (c.take(/(?:좌우|양\s*옆|양\s*측면|측면|양쪽\s*옆|옆면)/)) { if (dim === 3) { add('ymin'); add('ymax'); } else { add('ymin'); add('ymax'); } }
  if (c.take(/(?:위\s*아래|상하)\s*(?:면|변)?/)) { if (dim === 3) { add('zmin'); add('zmax'); } else { add('ymin'); add('ymax'); } }
  if (c.take(/(?:바닥|지면|땅|하단|밑면|아랫\s*면|아래\s*면|floor|ground|bottom)(?:면)?/)) add(dim === 3 ? 'zmin' : 'ymin');
  if (c.take(/(?:천장|상단|윗\s*면|위\s*면|꼭대기|하늘|ceiling|top)(?:면)?/)) add(dim === 3 ? 'zmax' : 'ymax');
  if (c.take(/(?:왼\s*쪽|좌측|left)(?:\s*(?:면|변))?/)) add('xmin');
  if (c.take(/(?:오른\s*쪽|우측|right)(?:\s*(?:면|변))?/)) add('xmax');
  if (dim === 2 && c.take(/(?:아래|아랫)\s*(?:쪽|변)?(?![가-힣])/)) add('ymin');
  if (dim === 2 && c.take(/(?:위|윗)\s*(?:쪽|변)?(?![가-힣])/)) add('ymax');
  if (c.take(/(?:입구|유입구|유입\s*면|들어오는\s*(?:면|쪽|곳)|inlet|풍상)/)) add(ctx.inletFace || 'xmin');
  if (c.take(/(?:출구|유출구|나가는\s*(?:면|쪽|곳)|outlet|풍하)/)) add(ctx.outletFace || 'xmax');
  return [...out];
}

function bcTypeOf(c) {
  if (c.take(/주기|periodic|순환\s*경계/)) return 'periodic';
  if (c.take(/미끄럼\s*벽?|slip|대칭|symmetry|free[-\s]?slip|마찰\s*없/)) return 'slip';
  if (c.take(/자유\s*유출|outflow|열린\s*(?:출구|경계)|zero[-\s]?gradient|빠져\s*나가/)) return 'outflow';
  if (c.take(/압력\s*(?:출구|경계)?|pressure/)) return 'pressure';
  if (c.take(/(?:no[-\s]?slip|점착|막힌|막아|막고|닫아|닫힌|벽면|벽|wall)/)) return 'wall';
  if (c.take(/(?:유입|속도\s*(?:경계|입구)?|velocity|inflow)/)) return 'velocity';
  if (c.take(/(?:유출|출구로)/)) return 'outflow';
  return null;
}

function targetOf(c, ctx) {
  let m;
  if (c.take(/(?:모든|전체|모두)\s*(?:객체|물체|건물|형상)/)) return 'all';
  if ((m = c.take(/(\d+)\s*번(?:째)?\s*(?:객체|물체|건물)?/))) return +m[1];
  if ((m = c.take(/(?:객체|물체|obj(?:ect)?)\s*#?\s*(\d+)/))) return +m[1];
  const names = (ctx.objects || []).map((o, i) => [o.toLowerCase(), i]).sort((a, b) => b[0].length - a[0].length);
  for (const [n, i] of names) if (n && c.w.includes(n)) { const k = c.w.indexOf(n); c.w = c.w.slice(0, k) + ' '.repeat(n.length) + c.w.slice(k + n.length); return i + 1; }
  if (c.take(/(?:선택(?:한|된)?\s*(?:객체|물체|것)?|이\s*(?:객체|물체|것)|그\s*(?:객체|물체|것)|selected)/)) return 'selected';
  return null;
}

const KIN_I = { 3: { low: 'low', mid: 'mid', high: 'high' }, 2: { low: 'light', mid: 'normal', high: 'heavy' } };
const KIN_K = { 3: { soft: 'soft', mid: 'mid', stiff: 'stiff' }, 2: { soft: 'soft', mid: 'medium', stiff: 'stiff' } };
const KIN_C = { 3: { low: 'low', mid: 'mid', high: 'high' }, 2: { low: 'low', mid: 'medium', high: 'high' } };

function parseClause(raw, dim, ctx) {
  const c = new Clause(raw), ops = [], ask = [], notes = [], flags = {};
  const D = dim === 3 ? 3 : 2;
  if (c.take(/되돌려|되돌리|취소해|원래대로|undo|ctrl\s*\+?\s*z/)) { flags.undo = true; return { c, ops, ask, notes, flags }; }
  if (c.take(/(?:해석|계산|시뮬레이션)?\s*(?:중단|멈춰|멈추|정지|스톱|stop)/)) { ops.push({ op: 'stop' }); return { c, ops, ask, notes, flags }; }
  const runWord = /(?:해석|계산|시뮬레이션)\s*(?:을|를)?\s*(?:실행|시작|돌려|돌리|해\s*줘|해줘|해봐|ㄱㄱ|go)|(?:^|\s)(?:실행|run|돌려\s*(?:줘|봐)|시작해)(?:\s|$)/;
  if (c.has(runWord)) { c.take(runWord); flags.run = true; }

  if (c.has(/(?:얼마|몇|알려|어때|어떻게\s*돼|확인|보여)\s*/) && c.has(/(?:레이놀즈|re(?![a-z])|셀\s*수|격자\s*수|τ|타우|tau|메모리|시간\s*간격|δt|dt|스텝|조건\s*요약|현재\s*(?:조건|설정))/)) {
    c.take(/(?:레이놀즈\s*수?|re(?![a-z])|셀\s*수|격자\s*수|τ|타우|tau|메모리|시간\s*간격|δt|dt|스텝\s*수?|조건\s*요약|현재\s*(?:조건|설정))/g);
    c.w = c.w.replace(/(?:레이놀즈\s*수?|셀\s*수|격자\s*수|τ|타우|tau|메모리|시간\s*간격|스텝\s*수?|조건\s*요약|현재\s*(?:조건|설정)|얼마|몇|알려|어때|확인|보여)/g, ' ');
    flags.answered = true; notes.push(ctx.paramsText || '현재 조건을 확인할 수 없습니다.');
    return { c, ops, ask, notes, flags };
  }

  let m;
  if ((m = c.take(/^\s*(\S.*?)\s*예제\s*(?:을|를)?\s*(?:불러|열어|로드|load|가져)\S*/)) || (m = c.take(/(?:예제|샘플\s*케이스|example)\s*(?:중에?\s*)?(?:으로\s*)?(.*?)\s*(?:을|를)?\s*(?:불러|열어|로드|load|가져)\S*/))) {
    const q = (m[1] || '').trim(), ex = (ctx.examples || []);
    const hit = ex.find((e) => q && (e.title.toLowerCase().includes(q) || q.includes(e.title.toLowerCase()) || e.file.toLowerCase().includes(q.replace(/\s+/g, '_')))) || ex.find((e) => q && q.split(/\s+/).some((w) => w.length >= 2 && e.title.toLowerCase().includes(w)));
    if (hit) ops.push({ op: 'load_example', name: hit.file }); else ask.push(`예제 '${q}'를 찾지 못했습니다. 가능한 예제: ${ex.map((e) => e.title).join(', ')}`);
    c.w = ' '.repeat(c.w.length);
    return { c, ops, ask, notes, flags };
  }
  if (D === 2 && c.take(/샘플\s*(?:5\s*종|다섯\s*개|도형)?\s*(?:을|를)?\s*(?:추가|불러|넣)/)) { ops.push({ op: 'add_samples' }); return { c, ops, ask, notes, flags }; }

  if (c.has(/(?:공기|air|물(?![체리질])|water|데모|층류\s*데모)/) && !c.has(/(?:유입|불어|바람)/)) {
    const fl = { op: 'set_fluid' };
    if (c.take(/공기|air/)) fl.preset = 'air'; else if (c.take(/물(?![체리질])|water/)) fl.preset = 'water'; else if (D === 2 && c.take(/(?:층류\s*)?데모/)) fl.preset = 'demo';
    c.take(/\d+\s*°\s*c|\d+\s*도\s*(?=\s*(?:의|인)?\s*(?:공기|물))|상온|실온/);
    c.take(/(?:유체|매질)\s*(?:를|을|는|은)?/);
    ops.push(fl);
  }
  if ((m = c.take(re(`(?:동\\s*)?점성(?:\\s*계수)?|ν|nu(?![a-z])|kinematic\\s*viscosity`)))) {
    const v = c.take(re(`(?:=|:|는|은|을|를)?\\s*${NUM}\\s*(?:m\\s*(?:2|²|\\^2)\\s*/\\s*s)?`));
    if (v) ops.push({ op: 'set_fluid', nu: f(v[1]) }); else ask.push('동점성계수 값(m²/s)을 알려 주세요.');
  }
  if (c.take(/밀도|ρ|rho(?![a-z])|density/)) {
    const v = c.take(re(`(?:=|:|는|은|을|를)?\\s*${NUM}\\s*(?:kg\\s*/\\s*m\\s*(?:3|³|\\^3))?`));
    if (v) ops.push({ op: 'set_fluid', rho: f(v[1]) }); else ask.push('밀도 값(kg/m³)을 알려 주세요.');
  }
  if (c.has(/les|난류\s*모델|smagorinsky|스마고린스키/)) {
    c.take(/les|난류\s*모델|smagorinsky|스마고린스키/);
    const off = !!c.take(/끄|꺼|off|해제|없이|빼/); c.take(/켜|on|사용|적용/);
    const o = { op: 'set_fluid', les: !off };
    if (D === 2 && (m = c.take(re(`(?:cs|c_s|상수)\\s*(?:=|:)?\\s*${NUM}`)))) o.cs = f(m[1]);
    ops.push(o);
  }

  if (c.has(/(?:도메인|해석\s*영역|계산\s*영역|영역\s*크기|격자판|domain)/) || c.has(/(?:원점|origin)/)) {
    c.take(/(?:도메인|해석\s*영역|계산\s*영역|영역\s*크기|격자판|domain)\s*(?:크기|사이즈|size)?/);
    const o = { op: 'set_domain' };
    if (c.take(/(?:원점|origin)/)) { const v = vectorOf(c, D); if (v) o.origin = v; else ask.push(`원점 좌표를 (${D === 3 ? 'x, y, z' : 'x, y'}) mm 형식으로 알려 주세요.`); }
    const s = sizeOf(c, D);
    if (s) { o.size = s.v; if (s.guessed) notes.push('크기에 단위가 없어 m로 해석했습니다'); }
    for (const [k, p] of [['Lx', /(?:길이|가로|lx|x\s*방향\s*길이)\s*(?:를|을|는|은)?/], ['Ly', D === 3 ? /(?:폭|너비|ly)\s*(?:를|을|는|은)?/ : /(?:세로|높이|ly)\s*(?:를|을|는|은)?/], ['Lz', /(?:높이|lz)\s*(?:를|을|는|은)?/]]) {
      if (k === 'Lz' && D === 2) continue;
      if (c.take(p)) { const L = lengthOf(c); if (L) o[k] = L; }
    }
    if (Object.keys(o).length > 1) ops.push(o);
  }
  if (c.has(/(?:격자|셀|cell|grid|δx|dx|해상도|분할|nx|메쉬|메시)/)) {
    const o = { op: 'set_domain' };
    c.take(/(?:격자|셀|cell|grid|메쉬|메시)\s*(?:크기|간격|사이즈|size)?|δx|dx|해상도/);
    if ((m = c.take(re(`(?:가로\\s*)?(?:분할|nx)\\s*(?:수)?\\s*(?:=|:|를|을)?\\s*${NUM}`))) || (m = c.take(re(`${NUM}\\s*(?:분할|칸)`)))) {
      if (D === 2) o.Nx = Math.round(f(m[1])); else o.cells_x = Math.round(f(m[1]));
    }
    const L = lengthOf(c);
    if (L) o.dx = L; else if ((m = c.take(re(`(?:=|:)\\s*${NUM}`)))) o.dx = f(m[1]);
    if (c.take(/(?:더\s*)?(?:촘촘|세밀|조밀|곱게|정밀|fine|키워)/)) o.refine = 1.5;
    else if (c.take(/(?:더\s*)?(?:거칠|성기|듬성|coarse|빠르게)/)) o.refine = 1 / 1.5;
    if (Object.keys(o).length > 1) ops.push(o);
  }

  const run = { op: 'set_run' };
  if (c.take(/(?:해석|계산|시뮬레이션)\s*시간|총\s*시간|duration|종료\s*시간|end\s*time/)) { const t = timeOf(c); if (t) run.duration = t; else ask.push('해석 시간을 초 단위로 알려 주세요.'); }
  if (c.take(/(?:속도\s*)?램프|ramp|서서히\s*올리는\s*시간/)) { const t = timeOf(c); if (t !== null) run.ramp = t; }
  if (c.take(/(?:평균|mean)\s*(?:시작|구간\s*시작)?/)) { const t = timeOf(c); if (t !== null) run.avg_start = t; else c.w += ' 평균'; }
  if ((m = c.take(re(`(?:프레임|frames?)\\s*(?:수)?\\s*(?:=|:|를|을)?\\s*${NUM}`))) || (m = c.take(re(`${NUM}\\s*(?:프레임|frames?)`)))) run.frames = Math.round(f(m[1]));
  if ((m = c.take(re(`(?:u_?lat(?:,?max)?|격자\\s*마하|격자\\s*속도)\\s*(?:=|:|를|을)?\\s*${NUM}`)))) run.u_lat_max = f(m[1]);
  if ((m = c.take(re(`(?:흡수층|스펀지|sponge)\\s*(?:두께)?\\s*(?:=|:|를|을)?\\s*${NUM}\\s*%?`)))) run.sponge = f(m[1]);
  if ((m = c.take(re(`(?:입자\\s*수|particles?)\\s*(?:=|:|를|을)?\\s*${NUM}`))) || (m = c.take(re(`(?:입자)\\s*${NUM}\\s*개`)))) run.particles = Math.round(f(m[1]));
  if (D === 3 && (m = c.take(/(gpu|cpu|자동)\s*(?:로|으로)?\s*(?:계산|돌려|실행|사용)?/))) run.backend = { gpu: 'gpu', cpu: 'cpu', 자동: 'auto' }[m[1]];
  if (Object.keys(run).length > 1) ops.push(run);

  const abl = c.has(/(?:대기\s*경계층|abl|경계층\s*(?:분포|프로파일)?|멱\s*법칙|power\s*law|로그\s*법칙|log\s*law|풍속\s*분포|높이에\s*따라)/);
  let prof = null;
  if (abl) {
    c.take(/(?:대기\s*경계층|abl|경계층)\s*(?:분포|프로파일|유입)?/);
    const log = !!c.take(/로그\s*법칙|log\s*law|로그/); c.take(/멱\s*법칙|power\s*law|멱/); c.take(/풍속\s*분포|높이에\s*따라\s*(?:다르게|변하게)?/);
    let terr = null;
    for (const [p, name, a, z0] of TERRAIN) if (c.take(p)) { terr = { name, a, z0 }; break; }
    c.take(/(?:지형|조도|지표면?)\s*(?:은|는|으로)?/);
    let zref = 10000;
    if ((m = c.take(/(?:기준\s*높이|z_?ref|reference\s*height)\s*(?:은|는|를|을|=)?/))) { const L = lengthOf(c); if (L) zref = L; }
    else if ((m = c.take(re(`${NUM}\\s*(mm|cm|m(?![a-z/]))\\s*(?:높이|고도|height)(?:에서|기준)?`)))) zref = f(m[1]) * { mm: 1, cm: 10, m: 1000 }[m[2]];
    let alpha = terr ? terr.a : 0.22, z0 = terr ? terr.z0 : 300;
    if ((m = c.take(re(`(?:α|alpha|알파|지수)\\s*(?:=|:|를|을|는)?\\s*${NUM}`)))) alpha = f(m[1]);
    if ((m = c.take(/(?:z0|z_0|z₀|조도\s*길이|거칠기\s*길이)\s*(?:=|:|를|을|는)?/))) { const L = lengthOf(c); if (L) z0 = L; else { const v = c.take(re(NUM)); if (v) z0 = f(v[1]); } }
    prof = log ? { type: 'log', zref, z0 } : { type: 'power', zref, alpha };
    if (terr) notes.push(`${terr.name} 지형: ${log ? `z₀ = ${z0} mm` : `α = ${alpha}`}`);
  }
  if (c.take(/균일\s*(?:분포|유입|속도)?|uniform/)) prof = { type: 'uniform' };

  let speed = speedOf(c);
  let press = pressureOf(c);
  if (press === null && c.has(/압력/)) { const pm = c.take(re(`(?:압력)\\s*(?:출구|경계)?\\s*(?:은|는|을|를|=|:)?\\s*${NUM}(?!\\s*(?:m|mm|cm|초|s|%|°|도|배|번))`)); if (pm) { press = f(pm[1]); c.w = c.w.slice(0, pm.index) + ' 압력' + c.w.slice(pm.index + 3); } }
  const hasObjWord = c.has(/(?:^|[^가-힣])(?:구(?![간역조])|공(?![기])|sphere|상자|박스|box|건물|로터|rotor|팬(?!더)|fan|풍차|프로펠러|판(?![단])|plate|객체|물체|(?<![가-힣])obj)|\d+\s*번\s*(?:객체|물체|건물)?|(?:선택|이|그)\s*(?:객체|물체|것)|이동|옮겨|회전|돌려|돌게|rpm|키워|줄여|배율|스케일|바닥에\s*(?:놓|붙)|중앙에|중앙으로|삭제|지워|없애|복제|자유\s*회전|힌지|구동|고정/) || (ctx.objects || []).some((n) => n && c.w.includes(n.toLowerCase()));
  const dir = dirOf(c);
  let faces = facesOf(c, D, ctx);
  const btype = bcTypeOf(c);
  const windish = c.has(/바람|풍속|유속|유입|불어|불게|흘려|흐르게|속도|inflow|wind/);
  const isPatch = c.has(/(?:구간|패치|patch|부분\s*유입|일부|원형\s*(?:유입|구멍|구간)|사각\s*(?:유입|구간)|덕트\s*구멍|토출구|디퓨저)/);

  if (isPatch && (speed !== null || press !== null || btype)) {
    c.take(/(?:구간|패치|patch|부분\s*유입|일부|토출구|디퓨저|덕트\s*구멍)/);
    const face = faces[0] || ctx.inletFace || 'xmin', p = { op: 'add_patch', face, type: btype && btype !== 'wall' ? btype : (press !== null ? 'pressure' : speed !== null ? 'velocity' : 'outflow') };
    if (speed !== null) p.speed = speed; if (press !== null) p.p = press;
    if (D === 3) {
      if (c.take(/원형|원(?![점])|circle|둥근/)) { p.shape = 'circle'; if (c.take(/(?:반지름|반경|r(?![a-z]))\s*(?:=|:|이|은|는)?/)) { const L = lengthOf(c); if (L) p.r = L; } else if (c.take(/(?:지름|직경|d(?![a-z]))\s*(?:=|:|이|은|는)?/)) { const L = lengthOf(c); if (L) p.r = L / 2; } }
      else { c.take(/사각(?:형)?|rect/); p.shape = 'rect'; const s = sizeOf(c, 2); if (s) p.size = s.v; }
      if (c.take(/(?:중심|center|위치)/)) { const v = vectorOf(c, 2); if (v) p.center = v; }
    } else {
      if ((m = c.take(re(`${NUM}\\s*(mm|m(?![a-z/]))?\\s*(?:에서|부터|~|-)\\s*${NUM}\\s*(mm|m(?![a-z/]))?\\s*(?:까지|사이)?`)))) { const k = { mm: 1, m: 1000 }[m[4] || m[2]] || 1; p.range = [f(m[1]) * k, f(m[3]) * k]; } else ask.push('구간의 시작·끝 위치(mm)를 알려 주세요. 예: 왼쪽 변 2000~4000 mm 구간에 3 m/s');
    }
    ops.push(p);
    speed = null;
  } else if (!hasObjWord && (speed !== null || (windish && (dir || prof)) || (prof && !faces.length) || (btype === 'velocity'))) {
    let face = faces[0];
    if (dir) face = `${'xyz'[dir.axis]}${dir.sign > 0 ? 'min' : 'max'}`;
    if (!face) face = ctx.inletFace || 'xmin';
    if (D === 2 && !EDGE_OF[face]) face = 'xmin';
    const o = { op: 'set_face', face, type: 'velocity' };
    if (speed !== null) o.speed = speed;
    else if (!ctx.faceTypes || ctx.faceTypes[face] !== 'velocity') ask.push('유입 속도(m/s)를 알려 주세요.');
    if (prof && D === 3) o.profile = prof;
    if (prof && D === 2) notes.push('대기경계층 분포는 3D에서만 지원합니다 (2D는 균일 유입)');
    ops.push(o);
    for (const k of faces.slice(1)) if (k !== face) ops.push({ ...o, face: k });
    if (!faces.length && ctx.inletFace && face !== ctx.inletFace && ctx.faceTypes?.[ctx.inletFace] === 'velocity') notes.push('기존 유입면은 그대로 두었습니다');
    speed = null;
  } else if (!hasObjWord && (btype || press !== null) && (faces.length || press !== null || btype === 'outflow')) {
    const t = btype || 'pressure';
    if (!faces.length) faces = [t === 'pressure' || t === 'outflow' ? ctx.outletFace || 'xmax' : ''].filter(Boolean);
    if (!faces.length) ask.push(`어느 면에 ${TYPE_KO[t]} 조건을 줄지 알려 주세요.`);
    for (const k of faces) { const o = { op: 'set_face', face: k, type: t }; if (t === 'pressure') o.p = press ?? 0; ops.push(o); }
  } else if (!hasObjWord && prof && faces.length) {
    for (const k of faces) ops.push({ op: 'set_face', face: k, type: 'velocity', profile: prof });
  }

  if (hasObjWord || (speed !== null && !ops.length)) objectOps(c, D, ctx, ops, ask, notes, speed, press, dir);

  if (c.has(/프로브|probe|측정점|모니터링\s*점|센서/)) {
    c.take(/프로브|probe|측정점|모니터링\s*점|센서/);
    if (c.take(/(?:모두|전부|다)\s*(?:삭제|지워|없애)|초기화|clear/)) ops.push({ op: 'clear', what: 'probes' });
    else { const pts = []; for (let v; (v = vectorOf(c, D));) pts.push(v); for (const p of pts) ops.push({ op: 'add_probe', pos: p }); if (!pts.length) ask.push(`프로브 좌표를 (${D === 3 ? 'x, y, z' : 'x, y'}) mm 형식으로 알려 주세요.`); }
  }
  if (c.has(/(?:구간|패치|patch)\s*(?:을|를)?\s*(?:모두|전부|다)?\s*(?:삭제|지워|없애|초기화)/)) { c.take(/(?:구간|패치|patch)\s*(?:을|를)?\s*(?:모두|전부|다)?\s*(?:삭제|지워|없애|초기화)/); ops.push({ op: 'clear', what: 'patches' }); }

  viewOps(c, D, ctx, ops);
  return { c, ops, ask, notes, flags };
}

function objectOps(c, D, ctx, ops, ask, notes, speed, press, dir) {
  let m;
  const SH = D === 3 ? [[/구(?![간역조])|공(?!기)|sphere|ball/, 'sphere'], [/상자|박스|box|직육면체|건물|블록/, 'box'], [/로터|rotor|팬(?!더)|fan|풍차|프로펠러|터빈|turbine/, 'rotor'], [/판(?![단])|plate|평판|날개판/, 'plate']] : [];
  const addVerb = /(?:추가|넣어|넣고|만들어|만들고|하나\s*(?:더)?|배치|생성|놓아\s*줘|add|create)/;
  for (const [p, shape] of SH) {
    if (!c.has(p) || !c.has(addVerb)) continue;
    c.take(p); c.take(addVerb);
    const o = { op: 'add_object', shape };
    if (shape === 'sphere') { if (c.take(/(?:반지름|반경|r(?![a-z]))\s*(?:=|:|이|은|는|를|을)?/)) { const L = lengthOf(c); if (L) o.r = L; } else if (c.take(/(?:지름|직경)\s*(?:=|:|이|은|는|를|을)?/)) { const L = lengthOf(c); if (L) o.r = L / 2; } }
    if (shape === 'box' || shape === 'plate') { const s = sizeOf(c, 3); if (s) o.size = s.v; }
    if (shape === 'rotor') { if (c.take(/(?:반지름|반경|r(?![a-z]))\s*(?:=|:|이|은|는|를|을)?/)) { const L = lengthOf(c); if (L) o.R = L; } else if (c.take(/(?:지름|직경)\s*(?:=|:|이|은|는|를|을)?/)) { const L = lengthOf(c); if (L) o.R = L / 2; } if ((m = c.take(re(`(?:날개|블레이드|blades?)\\s*${NUM}\\s*(?:개|장)?|${NUM}\\s*(?:개|장)?\\s*(?:날개|블레이드)`)))) o.blades = Math.round(f(m[1] || m[2])); }
    if (c.take(/(?:위치|중심|좌표|at)\s*(?:은|는|를|을|=)?/) || c.has(/\(/)) { const v = vectorOf(c, 3); if (v) o.pos = v; }
    if (c.take(/바닥에\s*(?:놓|붙|세워|올려)\S*/)) o.on_floor = true;
    if (c.take(/(?:가운데|중앙|중심)\S*/)) o.pos = 'center';
    if ((m = c.take(re(`(?:이름|name)\\s*(?:은|는|을|를|=)?\\s*['"]?([^'"\\s]+)['"]?`)))) o.name = m[1];
    ops.push(o);
    if (shape === 'rotor' && c.has(/rpm|자유\s*회전|돌게|구동/)) kinOps(c, D, 'last', ops, ask);
    return;
  }
  let target = targetOf(c, ctx);
  for (const [p] of SH) if (!target && c.take(p)) target = (ctx.objects || []).length === 1 ? 1 : 'selected';
  c.take(/(?:객체|물체|건물|형상)\s*(?:을|를|은|는)?/);
  if (!target && ctx.last && ctx.last.target) target = ctx.last.target;
  if (!target) target = (ctx.objects || []).length === 1 ? 1 : 'selected';
  if (ctx.last) ctx.last.target = target;
  if (target === 'selected' && ctx.selected == null && (ctx.objects || []).length !== 1) {
    if ((ctx.objects || []).length === 0) { ask.push('조건을 줄 객체가 없습니다. 먼저 객체를 불러오거나 추가해 주세요.'); return; }
    ask.push(`어느 객체인지 알려 주세요: ${(ctx.objects || []).map((n, i) => `${i + 1}번 ${n}`).join(', ')}`); return;
  }
  if (c.take(/삭제|지워|없애|제거|delete|remove/)) { ops.push({ op: 'remove_object', target }); return; }
  if (D === 3 && c.take(/복제|복사|duplicate|copy/)) { ops.push({ op: 'duplicate_object', target }); return; }
  const u = { op: 'update_object', target };
  if (c.take(/바닥에\s*(?:놓|붙|세워|올려|내려)\S*/)) u.on_floor = true;
  if (c.take(/(?:도메인\s*)?(?:가운데|중앙|중심)(?:으로|에)\s*\S*/)) u.center = true;
  if (c.has(/이동|옮겨|옮기|move|위치/)) {
    c.take(/(?:으?로\s*)?(?:이동|옮겨|옮기\S*|move)|위치\s*(?:를|을)?/);
    const v = vectorOf(c, D);
    if (v) u.pos = v;
    else {
      const L = lengthOf(c) ?? (() => { const n = c.take(re(NUM)); return n ? f(n[1]) : null; })();
      if (L !== null && dir) { const mv = new Array(D).fill(0); mv[dir.axis] = dir.sign * L; u.move = mv; }
      else if (L !== null) ask.push('이동 방향(x, y, z)을 알려 주세요.');
    }
  }
  const rpm = c.take(re(`${NUM}\\s*(?:rpm|알피엠|회전\\s*/\\s*분|r/min)`));
  const kinWord = c.has(/자유\s*(?:회전|롭게)|바람에\s*(?:따라\s*)?(?:돌|회전)|돌게|힌지|hinge|구동|강제\s*회전|고정(?!\s*(?:하중|단))|움직이지\s*않|free|drive/);
  if (rpm || kinWord) kinOps(c, D, target, ops, ask, rpm ? f(rpm[1]) : null, u);
  else if (c.has(/회전|돌려|rotate|기울/)) {
    c.take(/회전|돌려|rotate|기울\S*/);
    const ang = c.take(re(`${NUM}\\s*(?:°|도(?![가-힣])|deg)`));
    if (ang) {
      if (D === 3) { const ax = c.take(/([xyz])\s*축/) || (dir ? [0, 'xyz'[dir.axis]] : null); const r = [0, 0, 0]; r['xyz'.indexOf(ax ? ax[1] : 'z')] = f(ang[1]); u.rot_add = r; }
      else u.rot_add = f(ang[1]);
    } else ask.push('회전 각도(°)를 알려 주세요.');
  }
  if ((m = c.take(re(`(?:배율|스케일|scale)\\s*(?:을|를|=)?\\s*${NUM}`))) || (m = c.take(re(`${NUM}\\s*배\\s*(?:로)?\\s*(?:키워|크게|늘려|줄여|작게|확대|축소|스케일)?`)))) u.scale_mul = f(m[1]);
  else if (c.take(/(?:두\s*배|2\s*배)\s*(?:로)?\s*(?:키워|크게)/)) u.scale_mul = 2;
  else if (c.take(/(?:절반|반)\s*(?:으로)?\s*(?:줄여|작게)/)) u.scale_mul = 0.5;
  if (c.has(/유입\s*영역|분출|토출|내부\s*유입|송풍구/)) { c.take(/유입\s*영역|분출|토출|내부\s*유입|송풍구/); u.role = 'inlet'; if (speed !== null) { if (D === 3) { const a = dir ? dir.axis : 0, v = [0, 0, 0]; v[a] = (dir ? dir.sign : 1) * speed; u.inlet_u = v; } else u.inlet_speed = speed; } }
  else if (c.has(/유출\s*영역|흡입|배기구|흡입구/)) { c.take(/유출\s*영역|흡입|배기구|흡입구/); u.role = 'outlet'; if (press !== null) u.outlet_p = press; }
  else if (c.take(/고체로|solid|장애물로/)) u.role = 'solid';
  if (Object.keys(u).length > 2) ops.push(u);
}

function kinOps(c, D, target, ops, ask, rpm = null, into = null) {
  const k = {};
  if (rpm === null) { const r = c.take(re(`${NUM}\\s*(?:rpm|알피엠|회전\\s*/\\s*분|r/min)`)); if (r) rpm = f(r[1]); }
  if (rpm !== null) { k.mode = 'drive'; k.rpm = Math.abs(rpm); if (rpm < 0) k.dir = 'cw'; }
  if (c.take(/자유\s*(?:회전|롭게\s*(?:회전|돌))|바람에\s*(?:따라\s*)?(?:돌|회전)\S*|돌게|free/)) k.mode = 'free';
  else if (c.take(/힌지|hinge|경첩/)) k.mode = 'hinge';
  else if (c.take(/구동|강제\s*회전|drive/)) { k.mode = 'drive'; if (k.rpm === undefined) ask.push('회전수(rpm)를 알려 주세요.'); }
  else if (c.take(/고정(?!\s*(?:하중|단))|움직이지\s*않\S*|fix/)) k.mode = 'off';
  if (c.take(/시계\s*방향|cw(?![a-z])/)) k.dir = 'cw'; else if (c.take(/반시계\s*방향|ccw/)) k.dir = 'ccw';
  const ax = c.take(/([xyz])\s*축/);
  if (ax && D === 3) k.axis = ax[1];
  for (const [p, key, val] of [[/관성\s*(?:을|를|이)?\s*(?:크게|무겁게|큰)/, 'inertia', 'high'], [/관성\s*(?:을|를|이)?\s*(?:작게|가볍게|작은)/, 'inertia', 'low'], [/(?:무겁게|무거운)/, 'inertia', 'high'], [/(?:가볍게|가벼운)/, 'inertia', 'low'], [/(?:스프링|강성)\s*(?:을|를|이)?\s*(?:단단|세게|강하게|크게)\S*/, 'spring', 'stiff'], [/(?:스프링|강성)\s*(?:을|를|이)?\s*(?:부드럽|약하게|작게)\S*/, 'spring', 'soft'], [/감쇠\s*(?:를|을|가)?\s*(?:크게|높게|강하게)/, 'damping', 'high'], [/감쇠\s*(?:를|을|가)?\s*(?:작게|낮게|약하게)/, 'damping', 'low']]) {
    if (c.take(p)) k[key] = { inertia: KIN_I, spring: KIN_K, damping: KIN_C }[key][D][val];
  }
  c.take(/회전|돌려|돌리|돌아/);
  if (into && Object.keys(into).length > 2) { into.kin = k; return; }
  ops.push({ op: 'update_object', target: target === 'last' ? 'last' : target, kin: k });
}

function viewOps(c, D, ctx, ops) {
  let m;
  const v = { op: 'set_view' };
  if (c.take(/결과\s*(?:화면|보기|모드)?\s*(?:으로|로)?\s*(?:보여|전환|봐|보기|열어)\S*|result\s*view/)) v.mode = 'result';
  if (c.take(/편집\s*(?:화면|모드)?\s*(?:으로|로)?\s*(?:돌아|전환|가)\S*|edit\s*mode/)) v.mode = 'edit';
  const fields = D === 3 ? [[/압력\s*(?:장|분포|컨투어)?|pressure/, 'pressure'], [/와도|vorticity|소용돌이/, 'vort'], [/u_?x|x\s*방향\s*속도/, 'ux'], [/u_?y|y\s*방향\s*속도/, 'uy'], [/u_?z|z\s*방향\s*속도/, 'uz'], [/속도\s*(?:크기|장|분포|컨투어)|\|u\||풍속\s*(?:분포|장)/, 'umag']] : [[/압력\s*(?:장|분포|컨투어)?|pressure/, 'pressure'], [/와도|vorticity|소용돌이/, 'vort'], [/속도\s*(?:크기|장|분포|컨투어)|\|u\||풍속\s*(?:분포|장)/, 'umag']];
  const showVerb = /보여|표시|띄워|그려|볼래|보자|show|display|컨투어/;
  if (c.has(showVerb) || v.mode) for (const [p, k] of fields) if (c.take(p)) { v.field = k; v.mode = 'result'; break; }
  if (D === 3) {
    while ((m = c.take(/([xyz])\s*(?:=\s*)?(?:단면|slice|절단면)/)) || (m = c.take(/(?:단면|slice)\s*([xyz])/))) {
      const P = m[1].toUpperCase(), s = { axis: P, on: true };
      if (c.take(/끄|꺼|숨겨|off|없애/)) s.on = false;
      else { const L = lengthOf(c) ?? (() => { const n = c.take(re(`(?:=|위치)?\\s*${NUM}`)); return n ? f(n[1]) : null; })(); if (L !== null) s.at = L; }
      (v.slices = v.slices || []).push(s);
    }
    if ((m = c.take(/(?:카메라|시점|뷰)?\s*(위에서|평면|top|정면|front|측면|옆에서|side|iso|아이소|등각)\s*(?:시점|뷰|에서)?\s*(?:으로|로)?\s*(?:봐|보기|보여|전환|맞춰)?\S*/))) v.camera = { 위에서: 'top', 평면: 'top', top: 'top', 정면: 'front', front: 'front', 측면: 'side', 옆에서: 'side', side: 'side' }[m[1]] || 'iso';
  }
  const onoff = (p) => { if (!c.has(p)) return null; c.take(p); if (c.take(/끄|꺼|숨겨|빼|off|없애/)) return false; c.take(/켜|보여|표시|on|추가|그려/); return true; };
  let t;
  if ((t = onoff(/벡터|화살표|vectors?/)) !== null) v.vectors = t;
  if (D === 3 && c.has(/3d\s*유선|입체\s*유선|3차원\s*유선/)) { c.take(/3d\s*유선|입체\s*유선|3차원\s*유선/); c.take(/그려|보여|계산|표시/); ops.push({ op: 'analyze', kind: 'stream' }); }
  if (c.has(/유선|streamlines?/)) {
    c.take(/유선|streamlines?/);
    if (c.take(/(?:더\s*)?(?:촘촘|빽빽|많이|조밀)\S*/)) v.stream_density = 'up'; else if (c.take(/(?:더\s*)?(?:듬성|성기|적게)\S*/)) v.stream_density = 'down';
    if ((m = c.take(re(`(?:밀도)\\s*${NUM}`)))) v.stream_density = Math.round(f(m[1]));
    v.streams = !c.take(/끄|꺼|숨겨|off|없애/); c.take(/켜|보여|표시|그려/);
  }
  if ((t = onoff(/입자|particles?/)) !== null) v.particles = t;
  if ((t = onoff(/시간\s*평균장?|평균장|mean\s*field/)) !== null) v.mean = t;
  if (D === 2 && (t = onoff(/복셀|마스크|mask/)) !== null) v.mask = t;
  if (D === 3 && c.take(/q\s*(?:크라이테리온|criterion|와류|등치면|iso\S*|\s)+|와류\s*(?:구조|등치면)/)) { c.take(/그려|보여|계산|표시/); const a = { op: 'analyze', kind: 'qiso' }; if ((m = c.take(re(`${NUM}\\s*%`)))) a.level = f(m[1]); ops.push(a); }
  if (D === 3 && c.take(/vtk|파라뷰|paraview/)) { c.take(/저장|내보내\S*|export|다운로드/); ops.push({ op: 'analyze', kind: 'vtk' }); }
  if (c.has(/그래프|이력|시계열|plot|chart|추이/)) {
    c.take(/그래프|이력|시계열|plot|chart|추이/);
    const LQ = D === 3 ? [[/항력|f_?x|x\s*방향\s*힘/, 'fx'], [/횡력|f_?y|y\s*방향\s*힘/, 'fy'], [/양력|f_?z|z\s*방향\s*힘/, 'fz'], [/모멘트|토크|torque/, 'ma'], [/각도|회전각/, 'theta'], [/회전수|rpm/, 'rpm']] : [[/항력|f_?x/, 'fx'], [/양력|f_?y/, 'fy'], [/모멘트|토크/, 'm'], [/각도|회전각/, 'theta'], [/회전수|rpm/, 'rpm']];
    const PQ = [[/압력/, 'p'], [/u_?x/, 'ux'], [/u_?y/, 'uy'], [/u_?z/, 'uz'], [/속도|풍속/, 'umag']];
    const probe = !!c.take(/프로브|probe|측정점/);
    let done = false;
    if (!probe) for (const [p, q] of LQ) if (c.take(p)) { const o = { op: 'plot', source: 'load', qty: q }; const tg = targetOf(c, ctx); if (tg) o.target = tg; ops.push(o); done = true; break; }
    if (!done && (probe || D === 3)) for (const [p, q] of PQ) if (c.take(p)) { if (D === 3) ops.push({ op: 'plot', source: 'probe', qty: q }); done = true; break; }
    if (!done && !probe) ops.push({ op: 'plot', source: 'load', qty: 'fx' });
  }
  c.take(/보여\s*줘|보여|표시|켜\s*줘/);
  if (Object.keys(v).length > 1) ops.push(v);
}

export function describe(o, dim) {
  const fk = (k) => (dim === 2 ? EDGE_KO[EDGE_OF[k] || k] || k : FACE_KO[k] || k);
  if (o.edge && !o.face) o = { ...o, face: o.edge, op: o.op === 'set_edge' ? 'set_face' : o.op };
  const n = (v, d = 3) => (+(+v).toFixed(d)).toString();
  switch (o.op) {
    case 'set_face': return `${fk(o.face)} ${dim === 2 ? '변' : '면'}: ${TYPE_KO[o.type] || o.type}${o.speed !== undefined ? ` ${n(o.speed)} m/s` : ''}${o.p !== undefined && o.type === 'pressure' ? ` ${n(o.p)} Pa` : ''}${o.profile ? ` (${{ uniform: '균일', power: `멱법칙 α=${o.profile.alpha}`, log: `로그법칙 z₀=${o.profile.z0} mm` }[o.profile.type]}${o.profile.zref ? `, 기준높이 ${n(o.profile.zref / 1000)} m` : ''})` : ''}`;
    case 'add_patch': return `${fk(o.face)} ${dim === 2 ? '변' : '면'} 구간 추가: ${TYPE_KO[o.type]}${o.speed !== undefined ? ` ${n(o.speed)} m/s` : ''}${o.p !== undefined ? ` ${n(o.p)} Pa` : ''}`;
    case 'set_fluid': return `유체: ${[o.preset && { air: '공기', water: '물', demo: '층류 데모' }[o.preset], o.nu !== undefined && `ν=${o.nu}`, o.rho !== undefined && `ρ=${o.rho}`, o.les !== undefined && `LES ${o.les ? '켬' : '끔'}`].filter(Boolean).join(', ')}`;
    case 'set_domain': return `도메인: ${[o.size && `${o.size.map((v) => n(v / 1000)).join('×')} m`, o.Lx && `Lx ${n(o.Lx)} mm`, o.Ly && `Ly ${n(o.Ly)} mm`, o.Lz && `Lz ${n(o.Lz)} mm`, o.dx && `Δx ${n(o.dx)} mm`, o.Nx && `Nx ${o.Nx}`, o.cells_x && `x 분할 ${o.cells_x}`, o.refine && (o.refine > 1 ? '격자 세밀하게' : '격자 거칠게'), o.origin && `원점 (${o.origin.join(', ')})`].filter(Boolean).join(', ')}`;
    case 'set_run': return `해석 설정: ${Object.entries(o).filter(([k]) => k !== 'op').map(([k, v]) => `${{ duration: '시간', ramp: '램프', frames: '프레임', u_lat_max: 'u_lat', sponge: '흡수층 %', avg_start: '평균 시작', particles: '입자', backend: '장치' }[k] || k} ${v}`).join(', ')}`;
    case 'add_object': return `객체 추가: ${{ sphere: '구', box: '상자', rotor: '로터', plate: '판' }[o.shape] || o.shape}`;
    case 'update_object': return `객체 ${o.target === 'selected' ? '(선택)' : o.target === 'last' ? '(방금 추가)' : o.target} 수정${o.kin ? `: 운동 ${{ off: '고정', free: '자유 회전', hinge: '힌지', drive: `구동 ${o.kin.rpm ?? ''} rpm` }[o.kin.mode] || ''}` : ''}`;
    case 'remove_object': return `객체 ${o.target} 삭제`;
    case 'duplicate_object': return `객체 ${o.target} 복제`;
    case 'add_probe': return `프로브 추가 (${o.pos.join(', ')}) mm`;
    case 'set_view': return '표시 변경';
    case 'analyze': return { stream: '3D 유선 계산', qiso: 'Q 와류 등치면 계산', vtk: 'VTK 저장' }[o.kind];
    case 'plot': return `그래프: ${o.source === 'probe' ? '프로브' : '하중'} ${o.qty}`;
    case 'clear': return `${{ objects: '객체', patches: '구간', probes: '프로브' }[o.what]} 모두 삭제`;
    case 'load_example': return `예제 불러오기: ${o.name}`;
    case 'add_samples': return '샘플 도형 5종 추가';
    case 'stop': return '해석 중단';
    case 'run': return '해석 실행';
    default: return o.op;
  }
}

export function parse(text, dim, ctx = {}) {
  const ops = [], ask = [], notes = [], unknown = [], flags = {};
  const used = new Set(), last = {};
  for (const cl of splitClauses(text)) {
    let r;
    try { r = parseClause(cl, dim, { ...ctx, used, last }); } catch (e) { r = { c: { leftover: () => [cl] }, ops: [], ask: [], notes: [`'${cl}': ${e.message}`], flags: {} }; }
    for (const o of r.ops) if (o.op === 'set_face') used.add(o.face);
    if (dim === 2) for (const o of r.ops) if (o.face && o.op !== 'set_view') { o.edge = EDGE_OF[o.face] || o.face; delete o.face; if (o.op === 'set_face') o.op = 'set_edge'; }
    const left = r.c.leftover();
    ops.push(...r.ops); ask.push(...r.ask); notes.push(...r.notes); Object.assign(flags, r.flags);
    if (!r.ops.length && !r.ask.length && !Object.keys(r.flags).length) unknown.push(cl);
    else if (left.length && !r.flags.answered) unknown.push(`${cl} (남은 말: ${left.join(' ')})`);
  }
  const merged = [];
  for (const o of ops) {
    const key = ['set_face', 'set_edge'].includes(o.op) ? `${o.op}:${o.face || o.edge}` : ['set_fluid', 'set_run', 'set_domain', 'set_view'].includes(o.op) ? o.op : null;
    const prev = key && merged.find((x) => x._k === key);
    if (prev) { const { slices, ...rest } = o; Object.assign(prev, rest); if (slices) prev.slices = [...(prev.slices || []), ...slices]; } else merged.push(key ? { ...o, _k: key } : o);
  }
  ops.length = 0;
  for (const o of merged) { delete o._k; ops.push(o); }
  const parts = [];
  if (ops.length) parts.push(ops.map((o) => describe(o, dim)).join(' / '));
  if (flags.answered) parts.push(...notes.splice(0));
  if (notes.length) parts.push(`참고: ${notes.join(' · ')}`);
  if (ask.length) parts.push(`확인 필요: ${ask.join(' · ')}`);
  if (unknown.length) parts.push(`이해하지 못한 부분: ${unknown.join(' · ')}`);
  if (flags.run) parts.push('해석을 실행합니다');
  return { ops, reply: parts.join('\n') || '요청을 이해하지 못했습니다.', ask, unknown, run: !!flags.run, undo: !!flags.undo, answered: !!flags.answered, complete: !unknown.length && !ask.length };
}
