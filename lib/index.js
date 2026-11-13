/**
 * Host half of dsh-speed-monitor.
 *
 * 每 1 分钟（可配）对每个已选模型跑一轮流式请求，记录首字节 / 解码窗口 / 总耗时。
 * 模型清单来自 DSH 自身的设置（Client 通过 /api/settings/describe 拿到后推给本进程），
 * 密钥由 apiKeyEnv 指向 ~/.dsh/.credentials.yaml 里的字段，只在宿主侧使用。
 *
 * 对外接口：
 *   GET  /dsh-speed/api/state      配置 + 可用模型 + 历史
 *   POST /dsh-speed/api/providers  Client 推送 DSH 模型清单
 *   POST /dsh-speed/api/config     保存目标列表与采样间隔
 *   POST /dsh-speed/api/sample     立即采样（可只采一个目标）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'speed-monitor';
export const inject = ['webServer'];

const ROUTE_PREFIX = '/dsh-speed';

const DEFAULTS = {
  intervalMinutes: 1,
  runs: 3,
  maxTokens: 300,
  prompt: '写一段 100 字左右介绍杭州的文字，直接给正文。',
};

/** 支持 DSH_HOME 覆盖，便于用隔离的探针环境测试。 */
const DSH_HOME = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh');
const STORE_DIR = path.join(DSH_HOME, 'storages');
const CONFIG_FILE = path.join(STORE_DIR, 'speed-monitor.json');
const HISTORY_FILE = path.join(STORE_DIR, 'speed-monitor.jsonl');
const PROVIDERS_FILE = path.join(STORE_DIR, 'speed-monitor.providers.json');
const CREDENTIALS_FILE = path.join(DSH_HOME, '.credentials.yaml');

/** 取中位数，忽略 null。 */
function median(values) {
  const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!list.length) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : Math.round((list[middle - 1] + list[middle]) / 2);
}

/** 下发状态时把凭据字段名打码：客户端不需要它，泄露只会告诉别人去偷哪个槽。 */
export const KEY_ENV_MASK = '***'

export function redactProviders(all) {
  return Object.fromEntries(
    Object.entries(all ?? {}).map(([id, provider]) => [id, { ...provider, apiKeyEnv: provider?.apiKeyEnv ? KEY_ENV_MASK : '' }]),
  )
}

/**
 * 校验并合并 providers 写入。
 * 字段名回传 `***` 表示「保持原值」——这样状态可以脱敏，客户端整表回推也不会把配置清空。
 */
export function sanitizeProviders(previous, incoming) {
  const out = {}
  for (const [id, raw] of Object.entries(incoming ?? {}).slice(0, 50)) {
    if (!raw || typeof raw !== 'object') continue
    const baseURL = String(raw.baseURL ?? '').trim().slice(0, 300)
    if (baseURL && !/^https?:\/\//i.test(baseURL)) continue
    const incomingKey = String(raw.apiKeyEnv ?? '').trim()
    const apiKeyEnv = incomingKey === KEY_ENV_MASK
      ? String(previous?.[id]?.apiKeyEnv ?? '')
      : incomingKey.slice(0, 64)
    const models = (Array.isArray(raw.models) ? raw.models : [])
      .filter((model) => model && model.id)
      .slice(0, 100)
      .map((model) => ({ id: String(model.id).slice(0, 120), name: String(model.name ?? model.id).slice(0, 120) }))
    if (models.length === 0) continue
    out[String(id).slice(0, 64)] = {
      baseURL,
      apiKeyEnv,
      displayName: String(raw.displayName ?? id).slice(0, 120),
      models,
    }
  }
  return out
}

/** 从凭据文件按字段名取 key；读不到返回空串。 */
function readCredential(field) {
  if (!field) return '';
  // 字段名来自设置页/HTTP 请求：必须当字面量，否则 ".*" 能把文件里第一个 key 抓出来。
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(field)) return '';
  try {
    const text = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^\\s*${escaped}\\s*:\\s*(\\S+)`, 'm').exec(text);
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch {
    return '';
  }
}

/**
 * 这些接口能改采样目标（进而把 Bearer 凭据发到任意 baseURL），宿主 Web 服务却不做会话校验。
 * 只信任「本机回环 + 同源」：Host 挡 DNS rebinding，Origin 挡跨站 POST。
 * 隧道代理会把 Host/Origin 重写成上游地址，手机端不受影响。
 */
function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false;
  const host = String(hostHeader).trim().toLowerCase();
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
}

function isSameOrigin(originHeader, selfOrigin) {
  const origin = String(originHeader || '').trim()
  if (!origin) return true // 非浏览器客户端（curl / 测试）不带 Origin
  if (origin === 'null') return false // file:// 或 sandbox iframe
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  // 只放行回环来源：localhost 与 127.0.0.1 视为同一个服务（端口必须一致）。
  // evil.example 即使解析到 127.0.0.1，Origin 仍是它自己的域名，过不了这一关。
  if (!/^https?:$/.test(parsed.protocol) || !isLoopbackHost(parsed.host)) return false
  if (!selfOrigin) return true
  try {
    return new URL(selfOrigin).port === parsed.port
  } catch {
    return false
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 把 SSE 缓冲区切成完整的 data 行，返回剩余缓冲。 */
function splitEvents(buffer) {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const payloads = [];
  for (const line of lines) {
    const text = line.trim();
    if (text.startsWith('data:')) payloads.push(text.slice(5).trim());
  }
  return [payloads, rest];
}

/**
 * 跑一次流式请求。
 * @returns {Promise<object>} 各阶段耗时与用量，失败时带 error
 */
async function requestOnce(options, url, apiKey, model, effort) {
  const started = Date.now();
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: options.prompt }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: options.maxTokens,
    temperature: 0.3,
    ...(effort && effort !== 'default' ? { reasoning_effort: effort } : {}),
  });

  let ttfb = null;
  let last = null;
  let tokens = null;

  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        accept: 'text/event-stream',
      },
      body,
    });
    if (!response.ok || !response.body) {
      const detail = (await response.text().catch(() => '')).slice(0, 160).replace(/\s+/g, ' ');
      return { ok: false, error: `HTTP ${response.status} ${detail}`, total_ms: Date.now() - started };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const now = Date.now() - started;
      buffer += decoder.decode(value, { stream: true });
      const [payloads, rest] = splitEvents(buffer);
      buffer = rest;
      for (const payload of payloads) {
        if (!payload || payload === '[DONE]') continue;
        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }
        if (event.usage) tokens = event.usage.completion_tokens ?? null;
        const delta = event.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content || delta.reasoning_content || delta.reasoning) {
          if (ttfb === null) ttfb = now;
          last = now;
        }
      }
    }
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 160), total_ms: Date.now() - started };
  }

  const total = Date.now() - started;
  const decode = ttfb !== null && last !== null && last > ttfb ? last - ttfb : null;
  return {
    ok: true,
    ttfb_ms: ttfb,
    decode_ms: decode,
    total_ms: total,
    tokens,
    tps_decode: tokens && decode ? Math.round((tokens / (decode / 1000)) * 10) / 10 : null,
    tps_e2e: tokens ? Math.round((tokens / (total / 1000)) * 10) / 10 : null,
  };
}

export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, maxTokens: config.maxTokens || DEFAULTS.maxTokens, prompt: config.prompt || DEFAULTS.prompt };
  fs.mkdirSync(STORE_DIR, { recursive: true });

  /** 目标配置：targets = [{ id, provider, model, effort, intervalMinutes, runs, prompt }] */
  const saved = readJson(CONFIG_FILE, null);
  // 先算全局默认值：normalizeTarget 会用到它们（不能读 state，否则 state 还在初始化中）
  const defaultInterval = Number(saved?.intervalMinutes) > 0 ? Number(saved.intervalMinutes) : DEFAULTS.intervalMinutes;
  const defaultRuns = Number(saved?.runs) > 0 ? Number(saved.runs) : DEFAULTS.runs;
  const defaultPrompt = typeof saved?.prompt === 'string' && saved.prompt.trim() ? saved.prompt : DEFAULTS.prompt;

  /** 给单个模型补上间隔 / 次数 / 任务，缺省继承全局默认值。 */
  function normalizeTarget(target) {
    return {
      ...target,
      intervalMinutes: Number(target.intervalMinutes) > 0 ? Number(target.intervalMinutes) : defaultInterval,
      runs: Number(target.runs) > 0 ? Number(target.runs) : defaultRuns,
      prompt: typeof target.prompt === 'string' && target.prompt.trim() ? target.prompt : defaultPrompt,
      monitor: target.monitor !== false,
    };
  }

  const state = {
    intervalMinutes: defaultInterval,
    runs: defaultRuns,
    prompt: defaultPrompt,
    targets: Array.isArray(saved?.targets) ? saved.targets.filter((item) => item && item.provider && item.model).map(normalizeTarget) : [],
  };

  /** DSH 模型清单：{ [provider]: { baseURL, apiKeyEnv, models: [{id,name}] } } */
  let providers = readJson(PROVIDERS_FILE, {}) || {};

  /** 历史记录，新的在前。 */
  const history = [];
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          history.unshift(JSON.parse(line));
        } catch {
          /* 跳过损坏行 */
        }
      }
    }
  } catch {
    /* 存储不可用则退化为纯内存 */
  }

  let timer = null;
  let firstTimer = null;
  let running = false;
  let lastError = '';

  function nextTargetId() {
    return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  /** 补上默认目标：AstraHub deepseek-v4.1-flash（没有配置时）。 */
  function ensureDefaultTarget() {
    if (state.targets.length) return;
    const astra = providers['astra-hub'];
    if (astra?.models?.some((item) => item.id === 'deepseek-v4.1-flash')) {
      state.targets = [{ id: nextTargetId(), provider: 'astra-hub', model: 'deepseek-v4.1-flash', effort: 'low' }];
    } else {
      const [providerName, provider] = Object.entries(providers)[0] || [];
      if (providerName && provider?.models?.length) {
        state.targets = [{ id: nextTargetId(), provider: providerName, model: provider.models[0].id, effort: 'low' }];
      }
    }
    state.targets = state.targets.map(normalizeTarget);
    if (state.targets.length) writeJson(CONFIG_FILE, state);
  }

  /**
   * 采样一个目标。
   * 方法对齐 term-llm / llm-speed-test：先预热一次并丢弃（排除连接与缓存冷启动），
   * 再连发 runs 次取中位数，同时记录 min/max 用来看波动。
   */
  async function sampleTarget(target) {
    const provider = providers[target.provider];
    const apiKey = readCredential(provider?.apiKeyEnv);
    const base = { ts: new Date().toISOString(), target: target.id, provider: target.provider, model: target.model };

    if (!provider) {
      return { ...base, ok: 0, runs: 0, error: `未知供应商 ${target.provider}` };
    }
    if (!apiKey) {
      return { ...base, ok: 0, runs: 0, error: `缺少凭据 ${provider.apiKeyEnv || '(未配置 apiKeyEnv)'}` };
    }
    if (!provider.baseURL) {
      return { ...base, ok: 0, runs: 0, error: `供应商 ${target.provider} 没有 baseURL` };
    }

    const runs = Math.max(1, Number(target.runs) || 1);
    const promptOptions = { ...options, prompt: target.prompt || options.prompt };
    const key = `${target.provider}/${target.model}/${target.effort || 'default'}`;
    if (!warmed.has(key)) {
      await requestOnce(promptOptions, provider.baseURL, apiKey, target.model, target.effort).catch(() => null);
      warmed.add(key);
    }

    const rows = [];
    for (let index = 0; index < runs; index += 1) {
      rows.push(await requestOnce(promptOptions, provider.baseURL, apiKey, target.model, target.effort));
    }
    const ok = rows.filter((row) => row.ok);
    const span = (values) => {
      const list = values.filter((value) => Number.isFinite(value));
      return list.length ? { min: Math.min(...list), max: Math.max(...list) } : { min: null, max: null };
    };
    const ttfbSpan = span(rows.map((row) => row.ttfb_ms));
    const totalSpan = span(rows.map((row) => row.total_ms));
    const record = {
      ...base,
      ok: ok.length,
      runs: rows.length,
      ttfb_ms: median(rows.map((row) => row.ttfb_ms)),
      ttfb_min: ttfbSpan.min,
      ttfb_max: ttfbSpan.max,
      decode_ms: median(rows.map((row) => row.decode_ms)),
      total_ms: median(rows.map((row) => row.total_ms)),
      total_min: totalSpan.min,
      total_max: totalSpan.max,
      tokens: median(rows.map((row) => row.tokens)),
      tps_decode: median(rows.map((row) => row.tps_decode)),
      tps_e2e: median(rows.map((row) => row.tps_e2e)),
    };
    const errors = rows.filter((row) => !row.ok).map((row) => row.error);
    if (errors.length) record.error = errors.join('; ').slice(0, 300);
    return record;
  }

  /** 已经预热过的 目标键（换模型或重启后重置）。 */
  const warmed = new Set();

  /** 跑一轮全部目标并落盘。 */
  async function sampleAll(onlyId, subset) {
    if (running) return null;
    running = true;
    try {
      const targets = subset || (onlyId ? state.targets.filter((item) => item.id === onlyId) : state.targets.filter((item) => item.monitor !== false));
      if (!targets.length) {
        lastError = '还没有配置模型';
        return null;
      }
      if (!Object.keys(providers).length) {
        lastError = '还没拿到 DSH 的模型清单';
        return null;
      }
      const records = [];
      for (let index = 0; index < targets.length; index += 1) {
        if (index > 0) await new Promise((resolve) => setTimeout(resolve, 300));
        records.push(await sampleTarget(targets[index]));
      }
      for (const record of records) {
        history.unshift(record);
        try {
          fs.appendFileSync(HISTORY_FILE, `${JSON.stringify(record)}\n`, 'utf8');
        } catch {
          /* 写盘失败不影响内存 */
        }
      }
      lastError = records.map((record) => record.error).filter(Boolean).join('; ').slice(0, 300);
      return records;
    } finally {
      running = false;
    }
  }

  /** 每个模型下一次该采的「整点槽位」与对应间隔，用于墙钟对齐调度。 */
  const slotAt = new Map();

  /** 取下一个墙钟边界（如 1 分钟间隔 → xx:xx:00）。 */
  function nextSlot(intervalMs, from = Date.now()) {
    return Math.ceil(from / intervalMs) * intervalMs;
  }

  /** 到点的模型才采（每个模型自己的 intervalMinutes，按整点槽位）。 */
  async function sampleDue() {
    if (running) return;
    ensureDefaultTarget();
    const now = Date.now();
    const due = [];
    for (const target of state.targets) {
      if (target.monitor === false) continue;
      const intervalMs = Math.max(1, Number(target.intervalMinutes) || 1) * 60_000;
      const saved = slotAt.get(target.id);
      // 间隔变了或没有记录：重新对齐到下一个整点边界
      if (!saved || saved.intervalMs !== intervalMs) {
        slotAt.set(target.id, { at: nextSlot(intervalMs, now), intervalMs });
        continue;
      }
      if (now >= saved.at) {
        due.push(target);
        // 记录本轮实际触发的槽位；落后太多就跳到下一个未来槽位，避免补采风暴
        let at = saved.at + intervalMs;
        while (at <= now) at += intervalMs;
        slotAt.set(target.id, { at, intervalMs });
      }
    }
    if (!due.length) return;
    await sampleAll(null, due);
  }

  function restartTimer() {
    if (timer) clearInterval(timer);
    slotAt.clear();
    if (firstTimer) clearTimeout(firstTimer);
    firstTimer = setTimeout(() => void sampleDue(), 10_000);
    // 每 15 秒检查一次谁到点，间隔由每个模型自己决定
    timer = setInterval(() => void sampleDue(), 5_000);
  }
  restartTimer();

  const json = (res, status, payload) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(payload));
  };

  const readBody = (req) => new Promise((resolve) => {
    let raw = '';
    let overflow = false;
    req.on('data', (chunk) => {
      if (overflow) return;
      raw += chunk;
      // 超限直接判 413：截断后再 JSON.parse 只会得到误导性的 bad-json。
      if (raw.length > 256 * 1024) {
        overflow = true;
        raw = '';
      }
    });
    req.on('end', () => resolve(overflow ? null : raw));
    req.on('error', () => resolve(null));
  });

  // 注册路由：热重载时先释放上一次注册（挂在 globalThis 上，跨模块实例可见），
  // 否则会撞 duplicate prefix，插件路由整体 404。
  const ROUTE_KEY = Symbol.for('dsh-speed-monitor.route');
  if (globalThis[ROUTE_KEY]) {
    try {
      globalThis[ROUTE_KEY]();
    } catch {
      /* 旧实例可能已释放 */
    }
    delete globalThis[ROUTE_KEY];
  }
  try {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const pathname = String(req.url || '').split('?')[0];
        const method = String(req.method || 'GET').toUpperCase();
        const selfOrigin = (() => {
          try { return new URL(ctx.webServer.getOrigin?.() ?? '').origin; } catch { return ''; }
        })();
        if (!isLoopbackHost(req.headers?.host)) {
          json(res, 403, { error: 'forbidden-host' });
          return;
        }
        if (!isSameOrigin(req.headers?.origin, selfOrigin)) {
          json(res, 403, { error: 'forbidden-origin' });
          return;
        }

      if (pathname === `${ROUTE_PREFIX}/api/state`) {
        json(res, 200, { config: state, providers: redactProviders(providers), items: history, error: lastError });
        return;
      }

      if (pathname === `${ROUTE_PREFIX}/api/providers` && method === 'POST') {
        let body;
        try {
          const text = await readBody(req);
          if (text === null) {
            json(res, 413, { error: 'body-too-large' });
            return;
          }
          body = JSON.parse(text);
        } catch {
          json(res, 400, { error: 'bad-json' });
          return;
        }
        const incoming = body?.providers;
        if (incoming && typeof incoming === 'object') {
          // 白名单字段 + `***` 保持原值，避免整表回推把 apiKeyEnv 清空。
          const next = sanitizeProviders(providers, incoming);
          // 整表都非法时不要清空：多半是客户端发错，清空等于把采样配置删了。
          if (Object.keys(next).length > 0) providers = next;
          try {
            writeJson(PROVIDERS_FILE, providers);
          } catch {
            /* 忽略写盘失败 */
          }
          ensureDefaultTarget();
        }
        json(res, 200, { ok: true, targets: state.targets });
        return;
      }

      if (pathname === `${ROUTE_PREFIX}/api/config` && method === 'POST') {
        let body;
        try {
          const text = await readBody(req);
          if (text === null) {
            json(res, 413, { error: 'body-too-large' });
            return;
          }
          body = JSON.parse(text);
        } catch {
          json(res, 400, { error: 'bad-json' });
          return;
        }
        // 夹取范围：这两个值直接决定「每轮请求多少次、多久一轮」，不能让调用方随便放大。
        if (Number(body?.intervalMinutes) > 0) {
          state.intervalMinutes = Math.min(1440, Math.max(1, Number(body.intervalMinutes)));
        }
        if (Number(body?.runs) > 0) {
          state.runs = Math.min(10, Math.max(1, Math.trunc(Number(body.runs))));
        }
        if (Array.isArray(body?.targets)) {
          state.targets = body.targets
            .filter((item) => item && item.provider && item.model)
            .slice(0, 20)
            .map((item) => ({
              id: item.id || nextTargetId(),
              provider: String(item.provider),
              model: String(item.model),
              effort: item.effort ? String(item.effort) : 'low',
              // 每个模型自己的节奏与任务：之前这里被裁掉，导致保存后再展开配置被重置
              intervalMinutes: Math.min(1440, Math.max(1, Math.trunc(Number(item.intervalMinutes) || state.intervalMinutes))),
              runs: Math.min(20, Math.max(1, Math.trunc(Number(item.runs) || state.runs))),
              prompt: typeof item.prompt === 'string' && item.prompt.trim()
                ? item.prompt.slice(0, 2000)
                : state.prompt,
              monitor: item.monitor !== false,
            }));
        }
        try {
          writeJson(CONFIG_FILE, state);
        } catch {
          /* 忽略写盘失败 */
        }
        restartTimer();
        json(res, 200, { ok: true, config: state });
        return;
      }

      if (pathname === `${ROUTE_PREFIX}/api/sample` && method === 'POST') {
        let body = {};
        try {
          const text = await readBody(req);
          if (text === null) {
            json(res, 413, { error: 'body-too-large' });
            return;
          }
          body = JSON.parse(text || '{}');
        } catch {
          body = {};
        }
        const records = await sampleAll(body?.id);
        json(res, records ? 200 : 503, { records, error: lastError });
        return;
      }

      json(res, 404, { error: 'not-found' });
    },
    });
    globalThis[ROUTE_KEY] = dispose;
    if (ctx.effect) {
      ctx.effect(() => () => {
        try {
          dispose();
        } catch {
          /* 已释放 */
        }
        delete globalThis[ROUTE_KEY];
      });
    }
  } catch (error) {
    // 仍然撞车时让 activate 失败更明显：记错误但不吞掉，便于排查
    console.error('[dsh-speed-monitor] 路由注册失败：', error?.message || error);
    throw error;
  }

  if (ctx.effect) {
    ctx.effect(() => () => {
      if (timer) clearInterval(timer);
      if (firstTimer) clearTimeout(firstTimer);
    });
  }
}
