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
const KEEP = 5000;

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

/** 从凭据文件按字段名取 key；读不到返回空串。 */
function readCredential(field) {
  if (!field) return '';
  try {
    const text = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
    const match = new RegExp(`^\\s*${field}\\s*:\\s*(\\S+)`, 'm').exec(text);
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch {
    return '';
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

  /** 目标配置：targets = [{ id, provider, model, effort }] */
  const saved = readJson(CONFIG_FILE, null);
  const state = {
    // 全局值保留为「新模型的默认值」，实际采样用每个模型自己的配置
    intervalMinutes: Number(saved?.intervalMinutes) > 0 ? Number(saved.intervalMinutes) : DEFAULTS.intervalMinutes,
    runs: Number(saved?.runs) > 0 ? Number(saved.runs) : DEFAULTS.runs,
    prompt: typeof saved?.prompt === 'string' && saved.prompt.trim() ? saved.prompt : DEFAULTS.prompt,
    targets: Array.isArray(saved?.targets) ? saved.targets.filter((item) => item && item.provider && item.model).map(normalizeTarget) : [],
  };

  /** 给单个模型补上间隔 / 次数 / 任务，缺省继承全局值。 */
  function normalizeTarget(target) {
    return {
      ...target,
      intervalMinutes: Number(target.intervalMinutes) > 0 ? Number(target.intervalMinutes) : state.intervalMinutes,
      runs: Number(target.runs) > 0 ? Number(target.runs) : state.runs,
      prompt: typeof target.prompt === 'string' && target.prompt.trim() ? target.prompt : state.prompt,
    };
  }

  /** DSH 模型清单：{ [provider]: { baseURL, apiKeyEnv, models: [{id,name}] } } */
  let providers = readJson(PROVIDERS_FILE, {}) || {};

  /** 历史记录，新的在前。 */
  const history = [];
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).slice(-KEEP);
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
      const targets = subset || (onlyId ? state.targets.filter((item) => item.id === onlyId) : state.targets);
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
        lastRunAt.set(targets[index].id, Date.now());
      }
      for (const record of records) {
        history.unshift(record);
        try {
          fs.appendFileSync(HISTORY_FILE, `${JSON.stringify(record)}\n`, 'utf8');
        } catch {
          /* 写盘失败不影响内存 */
        }
      }
      if (history.length > KEEP) history.length = KEEP;
      lastError = records.map((record) => record.error).filter(Boolean).join('; ').slice(0, 300);
      return records;
    } finally {
      running = false;
    }
  }

  /** 每个模型上次采样的时间戳，用于按各自间隔调度。 */
  const lastRunAt = new Map();

  /** 到点的模型才采（每个模型自己的 intervalMinutes）。 */
  async function sampleDue() {
    if (running) return;
    ensureDefaultTarget();
    const now = Date.now();
    const due = state.targets.filter((target) => {
      const intervalMs = Math.max(1, Number(target.intervalMinutes) || 1) * 60_000;
      return now - (lastRunAt.get(target.id) || 0) >= intervalMs;
    });
    if (!due.length) return;
    await sampleAll(null, due);
  }

  function restartTimer() {
    if (timer) clearInterval(timer);
    if (firstTimer) clearTimeout(firstTimer);
    firstTimer = setTimeout(() => void sampleDue(), 10_000);
    // 每 15 秒检查一次谁到点，间隔由每个模型自己决定
    timer = setInterval(() => void sampleDue(), 15_000);
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
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 256 * 1024) raw = raw.slice(0, 256 * 1024);
    });
    req.on('end', () => resolve(raw));
    req.on('error', () => resolve(''));
  });

  // 注册路由：热重载时旧实例可能还没释放同名前缀，这里吞掉重复注册错误，
  // 避免整个插件 activate 失败（历史上表现为 webserver: duplicate prefix route）。
  try {
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const pathname = String(req.url || '').split('?')[0];
        const method = String(req.method || 'GET').toUpperCase();

      if (pathname === `${ROUTE_PREFIX}/api/state`) {
        json(res, 200, { config: state, providers, items: history.slice(0, 500), error: lastError });
        return;
      }

      if (pathname === `${ROUTE_PREFIX}/api/providers` && method === 'POST') {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          json(res, 400, { error: 'bad-json' });
          return;
        }
        const incoming = body?.providers;
        if (incoming && typeof incoming === 'object') {
          providers = incoming;
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
          body = JSON.parse(await readBody(req));
        } catch {
          json(res, 400, { error: 'bad-json' });
          return;
        }
        if (Number(body?.intervalMinutes) > 0) state.intervalMinutes = Number(body.intervalMinutes);
        if (Number(body?.runs) > 0) state.runs = Number(body.runs);
        if (Array.isArray(body?.targets)) {
          state.targets = body.targets
            .filter((item) => item && item.provider && item.model)
            .map((item) => ({
              id: item.id || nextTargetId(),
              provider: String(item.provider),
              model: String(item.model),
              effort: item.effort ? String(item.effort) : 'low',
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
          body = JSON.parse((await readBody(req)) || '{}');
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
  } catch (error) {
    const message = String(error?.message || error);
    if (!/duplicate prefix/i.test(message)) throw error;
    console.warn('[dsh-speed-monitor] 路由已被占用，跳过重复注册：', message);
  }

  if (ctx.effect) {
    ctx.effect(() => () => {
      if (timer) clearInterval(timer);
      if (firstTimer) clearTimeout(firstTimer);
    });
  }
}
