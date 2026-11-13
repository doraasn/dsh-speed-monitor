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
const SELF_ORIGIN = 'http://127.0.0.1:59681';
const HOST = '127.0.0.1:59681';
const ctx = {
  webServer: { register: (route) => { handler = route.handler; }, getOrigin: () => SELF_ORIGIN },
  effect: () => () => {},
};
apply(ctx, { intervalMinutes: 30 });

/** 造一个假请求，收 JSON。 */
const call = (url, method = 'GET', body, headers = { host: HOST }) => new Promise((resolve, reject) => {
  const listeners = {};
  const req = {
    url,
    method,
    headers,
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
  targets: [{ id: 't1', provider: 'astra-hub', model: 'deepseek-v4.1-flash', effort: 'none', intervalMinutes: 7, runs: 2, prompt: '自定义任务', monitor: false }],
});
check('配置保存成功', saved.status === 200 && saved.body.config.intervalMinutes === 2);
check('目标落盘', saved.body.config.targets[0].effort === 'none');
// 回归：每个模型的间隔/次数/任务/监控开关必须在保存后保留
const kept = saved.body.config.targets[0];
check('每模型字段不丢', kept.intervalMinutes === 7 && kept.runs === 2 && kept.prompt === '自定义任务' && kept.monitor === false, JSON.stringify(kept));

// 监控开关为 false 时不应参与采样：全部关闭 → 没有可采目标
const skipped = await call('/dsh-speed/api/sample', 'POST', {});
check('关闭监控的模型不参与采样', skipped.status === 503 && skipped.body.records === null, `实际 ${skipped.status} ${JSON.stringify(skipped.body).slice(0, 120)}`);

// 打开监控后恢复采样（baseURL 不可达，但会产出失败样本，说明确实执行了）
const enabled = await call('/dsh-speed/api/config', 'POST', {
  targets: [{ ...kept, monitor: true }],
});
check('重新开启监控', enabled.status === 200 && enabled.body.config.targets[0].monitor === true);

// 采样路径本身要能跑通（baseURL 不可达 → 记录 ok:0，但流程不抛错）
const sampled = await call('/dsh-speed/api/sample', 'POST', {});
check('开启监控后可执行采样', sampled.status === 200 && Array.isArray(sampled.body.records) && sampled.body.records.length === 1, `实际 ${sampled.status} ${JSON.stringify(sampled.body).slice(0, 120)}`);
check('采样失败被记录为 ok:0', sampled.body.records[0].ok === 0);

const again = await call('/dsh-speed/api/state');
check('配置持久化', again.body.config.intervalMinutes === 2 && again.body.providers['astra-hub'].models.length === 1);

const configFile = path.join(HOME, 'storages', 'speed-monitor.json');
check('配置文件已写盘', fs.existsSync(configFile));
check('未知路由 404', (await call('/dsh-speed/api/nope')).status === 404);
check('sample 需要 POST', (await call('/dsh-speed/api/sample')).status === 404);

// ---- 安全：Host/Origin 守卫 + 体积上限 + 参数夹取 ----
const rebind = await call('/dsh-speed/api/state', 'GET', undefined, { host: 'evil.example' });
check('伪造 Host 被拒（rebinding）', rebind.status === 403 && rebind.body.error === 'forbidden-host', `实际 ${rebind.status}`);

const csrf = await call('/dsh-speed/api/providers', 'POST', { providers: {} }, { host: HOST, origin: 'https://evil.example' });
check('跨站 Origin 被拒（CSRF）', csrf.status === 403 && csrf.body.error === 'forbidden-origin', `实际 ${csrf.status}`);

const nullOrigin = await call('/dsh-speed/api/config', 'POST', {}, { host: HOST, origin: 'null' });
check('Origin: null 被拒', nullOrigin.status === 403);

const sameOrigin = await call('/dsh-speed/api/state', 'GET', undefined, { host: HOST, origin: SELF_ORIGIN });
check('同源放行', sameOrigin.status === 200);

const huge = await call('/dsh-speed/api/config', 'POST', 'x'.repeat(300 * 1024), { host: HOST, origin: SELF_ORIGIN });
check('超大 body 返回 413', huge.status === 413, `实际 ${huge.status}`);

const clamped = await call('/dsh-speed/api/config', 'POST', { runs: 999, intervalMinutes: 0.1 }, { host: HOST, origin: SELF_ORIGIN });
check('runs 夹取到 10', clamped.body.config.runs === 10, `实际 ${clamped.body.config?.runs}`);
check('intervalMinutes 不小于 1', clamped.body.config.intervalMinutes === 1, `实际 ${clamped.body.config?.intervalMinutes}`);

// ---- 凭据字段名脱敏：下发打码，回推 `***` 保持原值 ----
const redacted = await call('/dsh-speed/api/state');
check('state 里 apiKeyEnv 已打码', redacted.body.providers['astra-hub'].apiKeyEnv === '***', JSON.stringify(redacted.body.providers['astra-hub']));

const echoBack = await call('/dsh-speed/api/providers', 'POST', {
  providers: { 'astra-hub': { ...redacted.body.providers['astra-hub'] } },
}, { host: HOST, origin: SELF_ORIGIN });
check('回推打码值不报错', echoBack.status === 200);
const providersFile = path.join(HOME, 'storages', 'speed-monitor.providers.json');
const stored = JSON.parse(fs.readFileSync(providersFile, 'utf8'));
check('打码回推后原字段名保留', stored['astra-hub'].apiKeyEnv === 'ASTRA_HUB_API_KEY', JSON.stringify(stored['astra-hub']));

const badBase = await call('/dsh-speed/api/providers', 'POST', {
  providers: { bad: { baseURL: 'file:///c:/x', apiKeyEnv: 'X', models: [{ id: 'm' }] } },
}, { host: HOST, origin: SELF_ORIGIN });
check('非法 baseURL 的 provider 被丢弃', badBase.status === 200);
const afterBad = JSON.parse(fs.readFileSync(providersFile, 'utf8'));
check('丢弃后原表仍在', afterBad['astra-hub']?.apiKeyEnv === 'ASTRA_HUB_API_KEY');

console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
