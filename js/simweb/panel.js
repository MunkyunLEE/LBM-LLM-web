import { PRESETS, MODES, loadCfg, saveCfg, configured, providerOf, askOps, testLLM } from './llm.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

const HTML = `
<section class="llm">
  <h2>LLM <small id="llmStatus"></small></h2>
  <div class="row2">
    <label>방식<select id="llmMode"><option value="rule_first">규칙 우선 (모르면 LLM)</option><option value="auto">LLM 우선 (실패 시 규칙)</option><option value="llm">LLM만</option><option value="rule">규칙 기반만</option></select></label>
    <label>제공자 프리셋<select id="llmPreset"></select></label>
  </div>
  <label class="wide">엔드포인트 (OpenAI 호환 또는 Anthropic)<input id="llmUrl" type="text" placeholder="예: https://api.openai.com/v1" autocomplete="off" spellcheck="false"></label>
  <div class="row2">
    <label>모델<input id="llmModel" type="text" placeholder="모델 이름" autocomplete="off" spellcheck="false"></label>
    <label>API 키<input id="llmKey" type="password" placeholder="sk-…" autocomplete="off"></label>
  </div>
  <label class="check"><input id="llmRemember" type="checkbox"> 이 브라우저에 키 기억 (끄면 탭을 닫을 때 지움)</label>
  <div class="chatbar"><button id="llmSave" class="ghost" type="button">적용</button><button id="llmTest" class="ghost" type="button">실제 응답 테스트</button></div>
  <div id="llmInfo"></div>
  <p class="keynote">키와 설정은 이 브라우저에만 저장됩니다. LLM에는 현재 조건 요약과 입력한 문장만 보내며, 형상 파일과 결과 데이터는 보내지 않습니다.</p>
</section>
<section class="chat">
  <h2>조건 · 결과 지시 <small><button id="chatUndo" class="ghost small" type="button" disabled>되돌리기</button></small></h2>
  <div id="chips"></div>
  <div id="chatLog"></div>
  <form id="chatForm"><textarea id="chatInput" rows="3"></textarea><button class="primary" type="submit">보내기</button></form>
</section>`;

export function mountAgent(root, A) {
  root.innerHTML = HTML;
  const $ = (id) => root.querySelector(`#${id}`);
  let cfg = loadCfg(), busy = null;
  const history = [];
  for (const p of PRESETS) $('llmPreset').add(new Option(p.label, p.id));
  $('chatInput').placeholder = A.placeholder || '';

  const fill = () => {
    $('llmMode').value = cfg.mode; $('llmUrl').value = cfg.url; $('llmModel').value = cfg.model; $('llmKey').value = cfg.key; $('llmRemember').checked = !!cfg.remember;
    const p = PRESETS.find((x) => x.url && x.url === cfg.url);
    $('llmPreset').value = p ? p.id : '';
    $('llmModel').placeholder = p?.model ? `예: ${p.model}` : '모델 이름';
  };
  const read = () => ({ mode: $('llmMode').value, url: $('llmUrl').value.trim(), model: $('llmModel').value.trim(), key: $('llmKey').value.trim(), remember: $('llmRemember').checked });

  function status(test) {
    const s = $('llmStatus');
    const on = configured(cfg);
    if (cfg.mode === 'rule') { s.textContent = '규칙 기반만'; s.className = ''; }
    else if (!on) { s.textContent = cfg.mode === 'llm' ? 'LLM 미설정' : '규칙 사용 · LLM 미설정'; s.className = cfg.mode === 'llm' ? 'bad' : ''; }
    else { s.textContent = `${providerOf(cfg.url)} · ${cfg.model}`; s.className = test ? (test.ok ? 'ok' : 'bad') : ''; }
    const rows = [];
    const add = (k, v, cls) => { const d = el('div'); const b = el('b', '', `${k} `); const sp = el('span', cls || '', v); d.append(b, sp); rows.push(d); };
    add('연결 대상', configured(cfg) ? `${providerOf(cfg.url)} · ${cfg.url}` : '없음 (엔드포인트와 모델을 입력하면 사용)');
    add('API 키', cfg.key ? `입력됨${cfg.remember ? ' · 기억' : ' · 이번 탭만'}` : '없음');
    add('현재 방식', MODES[cfg.mode]);
    if (test) {
      if (test.ok) add('실제 응답', `성공 (${(test.ms / 1000).toFixed(1)}초) · ${test.model || cfg.model} · JSON ${test.json_ok ? '정상' : '아님'} · "${test.reply}"`, test.json_ok ? 'good' : 'badt');
      else add('실제 응답', `실패: ${test.error}`, 'badt');
    }
    $('llmInfo').replaceChildren(...rows);
  }

  $('llmPreset').onchange = () => {
    const p = PRESETS.find((x) => x.id === $('llmPreset').value);
    if (p && p.url) { $('llmUrl').value = p.url; $('llmModel').placeholder = `예: ${p.model}`; }
  };
  $('llmSave').onclick = () => { cfg = read(); saveCfg(cfg); fill(); status(); };
  $('llmMode').onchange = () => { cfg = { ...cfg, mode: $('llmMode').value }; saveCfg(cfg); status(); };
  $('llmTest').onclick = async () => {
    cfg = read(); saveCfg(cfg); fill();
    if (!configured(cfg)) { status({ ok: false, error: '엔드포인트와 모델을 입력해 주세요.' }); return; }
    const b = $('llmTest'); b.disabled = true; b.textContent = '테스트 중…';
    const t = await testLLM(cfg);
    b.disabled = false; b.textContent = '실제 응답 테스트';
    status(t);
  };

  function addMsg(role, text, extra = {}) {
    const m = el('div', `msg ${role === 'user' ? 'user' : 'bot'}`);
    if (extra.engine) m.append(el('span', 'mtag', extra.engine === 'llm' ? `LLM · ${extra.model || ''}` : '규칙 기반'));
    if (text) m.append(document.createTextNode(text));
    if (extra.ops && extra.ops.length) m.append(el('div', 'ops', extra.ops.map((o) => JSON.stringify(o)).join('\n')));
    if (extra.note) m.append(el('div', 'notetxt', extra.note));
    if (extra.error) m.append(el('div', 'errtxt', `적용 실패: ${extra.error}`));
    $('chatLog').append(m);
    $('chatLog').scrollTop = $('chatLog').scrollHeight;
    return m;
  }

  function tryApply(ops) {
    const snap = A.snapshot();
    try { const log = A.apply(ops) || []; return { log, snap }; } catch (e) { A.restore(snap); throw e; }
  }

  const undoStack = [];
  const syncUndo = () => { $('chatUndo').disabled = !undoStack.length; };
  function undo() {
    const s = undoStack.pop(); syncUndo();
    if (!s) return false;
    A.restore(s); return true;
  }
  $('chatUndo').onclick = () => { if (undo()) addMsg('bot', '직전 상태로 되돌렸습니다.', { engine: 'rule' }); };

  async function send(text) {
    text = text.trim();
    if (!text || busy) return;
    addMsg('user', text);
    $('chatInput').value = '';
    const R = A.rules(text);
    const ruleOk = R.complete && R.ops.length > 0;
    const direct = ruleOk || R.undo || (R.ask.length && !R.unknown.length) || (R.answered && !R.unknown.length) || (R.run && !R.unknown.length && !R.ask.length);
    const mode = cfg.mode;
    const wantLLM = mode === 'auto' || mode === 'llm' || (mode === 'rule_first' && !direct);
    let ops = R.ops, reply = R.reply, engine = 'rule', note = '', model = '';
    if (wantLLM && !configured(cfg)) {
      if (mode === 'llm') { addMsg('bot', '', { error: 'LLM 엔드포인트와 모델이 설정되지 않았습니다. 위 LLM 칸에 입력해 주세요.' }); return; }
      if (mode === 'auto' || !direct) note = 'LLM이 설정되지 않아 규칙 기반 결과만 사용했습니다. 이해하지 못한 부분은 LLM을 연결하면 처리할 수 있습니다.';
    } else if (wantLLM) {
      const ctl = new AbortController();
      busy = ctl;
      const wait = addMsg('bot', '');
      const lab = el('span'), stop = el('button', 'danger stop', 'LLM 중단');
      stop.type = 'button'; stop.onclick = () => ctl.abort();
      wait.append(lab, stop);
      const t0 = Date.now(), tick = () => { lab.textContent = `LLM 응답 기다리는 중… ${Math.round((Date.now() - t0) / 1000)}초`; };
      tick();
      const timer = setInterval(tick, 1000);
      try {
        const ctx = A.context();
        let r = await askOps(cfg, A.system, ctx, history, text, { signal: ctl.signal });
        let applied = null;
        try { applied = tryApply(r.ops); } catch (e) {
          r = await askOps(cfg, A.system, ctx, history, text, { signal: ctl.signal, error: e.message });
          applied = null;
          try { applied = tryApply(r.ops); } catch (e2) { applied = { error: e2.message }; }
        }
        clearInterval(timer); wait.remove(); busy = null;
        history.push({ role: 'user', content: text }, { role: 'assistant', content: JSON.stringify({ ops: r.ops, reply: r.reply }) });
        history.splice(0, Math.max(0, history.length - 12));
        if (applied.error) { addMsg('bot', r.reply, { engine: 'llm', model: r.model, ops: r.ops, error: applied.error }); return; }
        if (r.ops.length) { undoStack.push(applied.snap); syncUndo(); }
        addMsg('bot', r.reply || (r.ops.length ? '적용했습니다.' : '적용할 내용이 없습니다.'), { engine: 'llm', model: r.model, ops: r.ops, note: (applied.log || []).join(' · ') });
        if (r.ops.some((o) => o.op === 'run')) A.run();
        return;
      } catch (e) {
        clearInterval(timer); wait.remove(); busy = null;
        if (ctl.signal.aborted) { addMsg('bot', 'LLM 요청을 중단했습니다.'); return; }
        if (mode === 'llm') { addMsg('bot', '', { error: `LLM 호출 실패: ${e.message}` }); return; }
        note = `LLM 호출에 실패해 규칙 기반 결과를 사용했습니다 (${String(e.message).slice(0, 160)})`;
      }
    }
    if (R.undo) {
      addMsg('bot', undo() ? '직전 상태로 되돌렸습니다.' : '되돌릴 내용이 없습니다.', { engine: 'rule' });
      return;
    }
    let error = '', log = [];
    if (ops.length) {
      try { const a = tryApply(ops); log = a.log; undoStack.push(a.snap); syncUndo(); } catch (e) { error = e.message; }
    }
    history.push({ role: 'user', content: text }, { role: 'assistant', content: JSON.stringify({ ops, reply }) });
    history.splice(0, Math.max(0, history.length - 12));
    addMsg('bot', reply, { engine, model, ops, note: [note, ...log].filter(Boolean).join(' · '), error });
    if (R.run && !error && !R.ask.length && !R.unknown.length) A.run();
  }

  $('chatForm').onsubmit = (e) => { e.preventDefault(); send($('chatInput').value); };
  $('chatInput').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send($('chatInput').value); } };

  function chips(list) {
    const c = $('chips'); c.innerHTML = '';
    for (const p of list || []) { const b = el('button', 'ghost', p); b.type = 'button'; b.onclick = () => send(p); c.append(b); }
  }

  fill(); status(); chips(A.chips);
  addMsg('bot', A.welcome || '조건을 문장으로 입력하면 왼쪽 설정에 바로 반영합니다.');
  return { chips, send, clear: () => { $('chatLog').innerHTML = ''; history.length = 0; } };
}

export function bindBottom() {
  const b = document.getElementById('bottom'), bar = document.getElementById('bottomBar'), car = document.getElementById('bottomCaret');
  if (!b || !bar) return;
  let collapsed = false;
  try { collapsed = localStorage.getItem('simweb-bottom') === '1'; } catch (_) {}
  const sync = () => { b.classList.toggle('collapsed', collapsed); car.textContent = collapsed ? '▸ 펼치기' : '▾ 접기'; window.dispatchEvent(new Event('resize')); };
  bar.onclick = () => { collapsed = !collapsed; try { localStorage.setItem('simweb-bottom', collapsed ? '1' : '0'); } catch (_) {} sync(); };
  new MutationObserver(() => { const c = b.classList.contains('collapsed'); if (c !== collapsed) { collapsed = c; car.textContent = collapsed ? '▸ 펼치기' : '▾ 접기'; } }).observe(b, { attributes: true, attributeFilter: ['class'] });
  sync();
}
