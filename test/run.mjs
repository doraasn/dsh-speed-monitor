/**
 * 宿主侧自测：临时 DSH_HOME、不联网、不碰真实 ~/.dsh。
 * 用法: npm test
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-speed-monitor-test.'));
process.env.DSH_HOME = HOME;

const { apply } = await import(new URL('../lib/index.js', import.meta.url).href);

let handler = null;
const ctx = {
  webServer: { register: (route) => { handler = route.handler; } },
  effect: () => () => {},
};
apply(ctx, { intervalMinutes: 30 });

/** 造一个假请求，收 JSON。 */
const call = (url, method = 'GET', body) => new Promise((resolve, reject) => {
  const listeners = {};
  const req = {
    url,
    method,
    on(event, cb) { listeners[event] = cb; },
    setEncoding() {},
    destroy() {},
  };
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { res.headers[name] = value; },
    get writableEnded() { return false; },
    end(text) {
      try { resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }); }
      catch (error) { reject(error); }
    },
  };
  handler(req, res);
  if (body !== undefined) listeners.data?.(JSON.stringify(body));
  listeners.end?.();
});

let passed = 0;
let failed = 0;
const check = (name, condition, extra = '') => {
  if (condition) passed += 1;
  else { failed += 1; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`); }
};

const state = await call('/dsh-speed/api/state');
check('state 返回配置', state.status === 200 && Array.isArray(state.body.config.targets), JSON.stringify(state.body).slice(0, 120));
check('初始没有历史', state.body.items.length === 0);

const providers = {
  'astra-hub': {
    baseURL: 'https://example.invalid/v1',
    apiKeyEnv: 'ASTRA_HUB_API_KEY',
    displayName: 'AstraHub',
    models: [{ id: 'deepseek-v4.1-flash', name: 'deepseek-flash' }],
  },
};
const pushed = await call('/dsh-speed/api/providers', 'POST', { providers });
check('providers 写入成功', pushed.status === 200 && pushed.body.ok === true);
check('自动补默认目标', pushed.body.targets.length === 1 && pushed.body.targets[0].model === 'deepseek-v4.1-flash', JSON.stringify(pushed.body.targets));

const saved = await call('/dsh-speed/api/config', 'POST', {
  intervalMinutes: 2,
  targets: [{ id: 't1', provider: 'astra-hub', model: 'deepseek-v4.1-flash', effort: 'none' }],
});
check('配置保存成功', saved.status === 200 && saved.body.config.intervalMinutes === 2);
check('目标落盘', saved.body.config.targets[0].effort === 'none');

const again = await call('/dsh-speed/api/state');
check('配置持久化', again.body.config.intervalMinutes === 2 && again.body.providers['astra-hub'].models.length === 1);

const configFile = path.join(HOME, 'storages', 'speed-monitor.json');
check('配置文件已写盘', fs.existsSync(configFile));
check('未知路由 404', (await call('/dsh-speed/api/nope')).status === 404);
check('sample 需要 POST', (await call('/dsh-speed/api/sample')).status === 404);

console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
