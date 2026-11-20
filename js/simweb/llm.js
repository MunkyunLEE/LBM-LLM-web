const STORE = 'simweb-llm';
const KEY_STORE = 'simweb-llm-key';

export const PRESETS = [
  { id: '', label: '직접 입력', url: '' },
  { id: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'anthropic', label: 'Anthropic', url: 'https://api.anthropic.com/v1', model: 'claude-haiku-4-5' },
  { id: 'gemini', label: 'Google Gemini (OpenAI 호환)', url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  { id: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
];

export const MODES = {
  rule_first: '규칙이 이해한 문장은 바로 처리하고, 못 알아들은 문장만 LLM으로 보냅니다',
  auto: '항상 LLM에 먼저 묻고, 실패하면 규칙 결과를 씁니다',
  llm: 'LLM만 사용합니다',
  rule: 'LLM을 부르지 않고 규칙만 사용합니다',
};

const store = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
const put = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) {} };
const sstore = (k) => { try { return sessionStorage.getItem(k); } catch (_) { return null; } };
const sput = (k, v) => { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (_) {} };

export function loadCfg() {
  let c = {};
  try { c = JSON.parse(store(STORE) || '{}'); } catch (_) {}
  const cfg = { mode: 'rule_first', url: '', model: '', remember: false, ...c };
  cfg.key = (cfg.remember ? store(KEY_STORE) : sstore(KEY_STORE)) || '';
  return cfg;
}

export function saveCfg(cfg) {
  const { key, ...rest } = cfg;
  put(STORE, JSON.stringify(rest));
  if (cfg.remember) { put(KEY_STORE, key || null); sput(KEY_STORE, null); } else { sput(KEY_STORE, key || null); put(KEY_STORE, null); }
}

export const configured = (cfg) => !!(cfg.url && cfg.model);

export function providerOf(url) {
  let h = '';
  try { h = new URL(url).hostname.toLowerCase(); } catch (_) { return url ? '주소 형식 오류' : '설정 안 됨'; }
  const names = { 'api.openai.com': 'OpenAI', 'api.anthropic.com': 'Anthropic', 'generativelanguage.googleapis.com': 'Google Gemini', 'openrouter.ai': 'OpenRouter' };
  return names[h] || h;
}

const isAnthropic = (url) => /(^|\.)anthropic\.com$/i.test((() => { try { return new URL(url).hostname; } catch (_) { return ''; } })()) || /\/anthropic(\/|$)/i.test(url);
const base = (url) => url.replace(/\/+$/, '').replace(/\/(chat\/completions|messages)$/, '');

function headersFor(cfg) {
  if (isAnthropic(cfg.url)) {
    const h = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
    if (cfg.key) h['x-api-key'] = cfg.key;
    return h;
  }
  const h = { 'Content-Type': 'application/json' };
  if (cfg.key) h.Authorization = `Bearer ${cfg.key}`;
  return h;
}

async function post(url, body, headers, signal, timeout = 120000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(new Error('응답 시간 초과')), timeout);
  const onAbort = () => ctl.abort(new Error('중단했습니다'));
  signal?.addEventListener('abort', onAbort);
  try {
    let r;
    try { r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal }); } catch (e) {
      if (ctl.signal.aborted) throw ctl.signal.reason || e;
      throw new Error(`요청을 보내지 못했습니다 (${e.message}). 주소가 맞는지, 그 서버가 브라우저 호출(CORS)을 허용하는지 확인해 주세요.`);
    }
    const text = await r.text();
    if (!r.ok) { const e = new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`); e.status = r.status; throw e; }
    return JSON.parse(text);
  } finally { clearTimeout(t); signal?.removeEventListener('abort', onAbort); }
}

export async function complete(cfg, system, messages, { signal, json = true } = {}) {
  if (!configured(cfg)) throw new Error('LLM 엔드포인트와 모델을 먼저 입력해 주세요.');
  const u = base(cfg.url), h = headersFor(cfg);
  if (isAnthropic(cfg.url)) {
    const body = { model: cfg.model, max_tokens: 2048, temperature: 0, system, messages: mergeRoles(messages) };
    const d = await post(`${u}/messages`, body, h, signal);
    return { text: (d.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''), model: d.model };
  }
  const body = { model: cfg.model, temperature: 0, stream: false, messages: [{ role: 'system', content: system }, ...messages] };
  if (json) body.response_format = { type: 'json_object' };
  let d;
  try { d = await post(`${u}/chat/completions`, body, h, signal); } catch (e) {
    if (!json || e.status !== 400) throw e;
    delete body.response_format;
    d = await post(`${u}/chat/completions`, body, h, signal);
  }
  return { text: d.choices?.[0]?.message?.content || '', model: d.model };
}

function mergeRoles(msgs) {
  const out = [];
  for (const m of msgs) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += `\n\n${m.content}`;
    else out.push({ role, content: m.content });
  }
  if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', content: '(시작)' });
  return out;
}

export function extractJSON(text) {
  const t = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '').trim();
  try { return JSON.parse(t); } catch (_) {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('LLM 응답에서 JSON을 찾지 못했습니다');
}

export async function askOps(cfg, system, context, history, text, { signal, error } = {}) {
  const msgs = [{ role: 'user', content: context }, { role: 'assistant', content: '{"ops":[],"reply":"현재 상태를 확인했습니다."}' }];
  for (const h of (history || []).slice(-6)) msgs.push({ role: h.role, content: h.content });
  msgs.push({ role: 'user', content: text });
  if (error) msgs.push({ role: 'user', content: `The previous ops failed validation: ${error}\nReturn corrected JSON only.` });
  const r = await complete(cfg, system, msgs, { signal });
  const data = extractJSON(r.text);
  const ops = data.ops ?? [];
  if (!Array.isArray(ops)) throw new Error('ops 가 배열이 아닙니다');
  return { ops, reply: String(data.reply ?? ''), model: r.model || cfg.model };
}

export async function testLLM(cfg, signal) {
  const t0 = performance.now();
  try {
    const r = await complete(cfg, 'Reply with ONE JSON object only: {"ops": [], "reply": "<short Korean greeting>"}', [{ role: 'user', content: '안녕' }], { signal });
    let ok = true, reply = r.text;
    try { reply = String(extractJSON(r.text).reply ?? ''); } catch (_) { ok = false; }
    return { ok: true, ms: Math.round(performance.now() - t0), model: r.model, json_ok: ok, reply: reply.slice(0, 160) };
  } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 300) }; }
}
