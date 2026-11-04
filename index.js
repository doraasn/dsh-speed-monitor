/**
 * Host half of dsh-speed-monitor.
 *
 * 每 5 分钟对 OpenAI 兼容中转（默认 AstraHub）跑一轮流式请求，记录
 * 首字节（TTFB）、解码窗口与总耗时，追加到 ~/.dsh/storages/speed-monitor.jsonl。
 *
 * 对外接口（Client 通过它们取数）：
 *   GET  /dsh-speed/api/history   最近采样记录
 *   POST /dsh-speed/api/sample    立即采样一轮
 *
 * 密钥只在本进程内使用，不回传浏览器；默认从 ~/.dsh/.credentials.yaml 的
 * ASTRA_HUB_API_KEY 读取。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'speed-monitor';
export const inject = ['webServer'];

const ROUTE_PREFIX = '/dsh-speed';
const HISTORY_PATH = `${ROUTE_PREFIX}/api/history`;
const SAMPLE_PATH = `${ROUTE_PREFIX}/api/sample`;
/** 内存里最多保留的历史条数，落盘不受限制。 */
const KEEP = 2000;

const DEFAULTS = {
  baseUrl: 'https://www.astrahub-ai.com/v1',
  model: 'deepseek-v4.1-flash',
  credential: 'ASTRA_HUB_API_KEY',
  intervalMinutes: 5,
  runs: 3,
  maxTokens: 300,
  effort: 'low',
  prompt: '写一段 100 字左右介绍杭州的文字，直接给正文。',
};

const STORE_DIR = path.join(os.homedir(), '.dsh', 'storages');
const STORE_FILE = path.join(STORE_DIR, 'speed-monitor.jsonl');
const CREDENTIALS_FILE = path.join(os.homedir(), '.dsh', '.credentials.yaml');

/** 取中位数，忽略 null。 */
function median(values) {
  const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!list.length) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : Math.round((list[middle - 1] + list[middle]) / 2);
}

/** 从凭据文件按字段名取 key；读不到返回空串。 */
function readCredential(field) {
  try {
    const text = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
    const match = new RegExp(`^\\s*${field}\\s*:\\s*(\\S+)`, 'm').exec(text);
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch {
    return '';
  }
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
 * @returns {Promise<{ok:boolean,ttfb_ms?:number,decode_ms?:number,total_ms?:number,tokens?:number,error?:string}>}
 */
async function requestOnce(options, apiKey) {
  const started = Date.now();
  const body = JSON.stringify({
    model: options.model,
    messages: [{ role: 'user', content: options.prompt }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: options.maxTokens,
    temperature: 0.3,
    ...(options.effort ? { reasoning_effort: options.effort } : {}),
  });

  let ttfb = null;
  let last = null;
  let tokens = null;

  try {
    const response = await fetch(`${options.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
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
  const options = { ...DEFAULTS, ...config };
  const apiKey = readCredential(options.credential);

  /** 最近采样记录，新的在前。 */
  const history = [];
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    if (fs.existsSync(STORE_FILE)) {
      const lines = fs.readFileSync(STORE_FILE, 'utf8').split('\n').filter(Boolean).slice(-KEEP);
      for (const line of lines) {
        try {
          history.unshift(JSON.parse(line));
        } catch {
          /* 跳过硬损坏行 */
        }
      }
    }
  } catch {
    /* 存储不可用时退化为纯内存 */
  }

  let lastError = '';
  let running = false;

  /** 跑一轮（options.runs 次请求）并落盘。 */
  async function sample() {
    if (running) return null;
    running = true;
    try {
      if (!apiKey) {
        lastError = `未找到凭据 ${options.credential}（~/.dsh/.credentials.yaml）`;
        return null;
      }
      const rows = [];
      for (let index = 0; index < Math.max(1, options.runs); index += 1) {
        rows.push(await requestOnce(options, apiKey));
      }
      const ok = rows.filter((row) => row.ok);
      const record = {
        ts: new Date().toISOString(),
        ok: ok.length,
        runs: rows.length,
        ttfb_ms: median(rows.map((row) => row.ttfb_ms)),
        decode_ms: median(rows.map((row) => row.decode_ms)),
        total_ms: median(rows.map((row) => row.total_ms)),
        tokens: median(rows.map((row) => row.tokens)),
        tps_decode: median(rows.map((row) => row.tps_decode)),
        tps_e2e: median(rows.map((row) => row.tps_e2e)),
      };
      const errors = rows.filter((row) => !row.ok).map((row) => row.error);
      if (errors.length) record.error = errors.join('; ').slice(0, 300);
      lastError = record.error || '';
      history.unshift(record);
      if (history.length > KEEP) history.length = KEEP;
      try {
        fs.mkdirSync(STORE_DIR, { recursive: true });
        fs.appendFileSync(STORE_FILE, `${JSON.stringify(record)}\n`, 'utf8');
      } catch {
        /* 写盘失败不影响内存数据 */
      }
      return record;
    } finally {
      running = false;
    }
  }

  ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const url = String(req.url || '');
      const pathname = url.split('?')[0];
      const json = (status, payload) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify(payload));
      };

      if (pathname === HISTORY_PATH || pathname === `${HISTORY_PATH}/`) {
        json(200, { items: history.slice(0, 500), error: lastError, model: options.model });
        return;
      }
      if (pathname === SAMPLE_PATH || pathname === `${SAMPLE_PATH}/`) {
        if ((req.method || '').toUpperCase() !== 'POST') {
          json(405, { error: 'method-not-allowed' });
          return;
        }
        const record = await sample();
        json(record ? 200 : 503, { record, error: lastError });
        return;
      }
      json(404, { error: 'not-found' });
    },
  });

  // 首轮延迟 15 秒，避开启动时的繁忙阶段；之后按间隔采样。
  const intervalMs = Math.max(60, Number(options.intervalMinutes) || 5) * 60 * 1000;
  const first = setTimeout(() => {
    void sample();
  }, 15_000);
  const timer = setInterval(() => {
    void sample();
  }, intervalMs);

  if (ctx.effect) {
    ctx.effect(() => () => {
      clearTimeout(first);
      clearInterval(timer);
    });
  }
}
