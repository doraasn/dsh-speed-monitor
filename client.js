/**
 * Client half of dsh-speed-monitor.
 *
 * 注册侧栏入口（sidebar.panellist）+ 右侧面板（main）：
 * 面板里选择要测的模型（来自 DSH 自己的模型清单）、设置采样间隔、看每 5 分钟/1 分钟的曲线。
 */
window.__ModuleLoader__.load({
  id: 'dsh-speed-monitor',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const PANEL_ID = 'dsh-speed-monitor';
    const API = '/dsh-speed/api';
    const TEXT_1 = 'var(--dsw-alias-label-primary)';
    const TEXT_2 = 'var(--dsw-alias-label-secondary)';
    const LINE = 'var(--dsw-alias-border-l2, #2a3038)';
    const BAD = '#ff6262';
    const PALETTE = ['#43c982', '#5aa9ff', '#efb83f', '#c47bff', '#ff8f6b', '#4dd0c4'];

    /** 界面固定中文。 */
    const T = {
      label: '速度监控',
      title: '速度监控',
      sample: '立即采样',
      sampling: '采样中…',
      interval: '采样间隔',
      minutes: '分钟',
      models: '测试模型',
      add: '添加模型',
      remove: '删除',
      effort: '思考',
      empty: '还没有可用的模型清单',
      noTargets: '点「添加模型」开始测速',
      ttfb: '首字节',
      total: '总耗时',
      tps: '端到端',
      recent: '最近采样',
      latest: '最新',
      time: '时间',
      chartTtfb: '首字节 TTFB（ms）',
      chartTotal: '总耗时（ms）',
      chartTps: '端到端吞吐（tok/s）',
      failed: '失败',
    };

    /** 从 DSH 设置里解析出供应商与模型：llm-pi-ai 的 providers、llm-deepseek 的 models。 */
    function buildProviders(namespaces) {
      const out = {};
      for (const entry of namespaces || []) {
        const ns = String(entry?.ns || '');
        if (!ns.startsWith('llm-')) continue;
        const value = entry?.value || {};
        if (value.providers && typeof value.providers === 'object') {
          for (const [name, provider] of Object.entries(value.providers)) {
            if (!provider?.models?.length) continue;
            out[name] = {
              baseURL: provider.baseURL || '',
              apiKeyEnv: provider.apiKeyEnv || '',
              models: provider.models.map((model) => ({ id: model.id, name: model.name || model.id })),
            };
          }
        } else if (Array.isArray(value.models) && value.models.length) {
          const name = ns === 'llm-deepseek' ? 'deepseek-official' : ns.replace(/^llm-/, '');
          out[name] = {
            baseURL: value.baseURL || (ns === 'llm-deepseek' ? 'https://api.deepseek.com' : ''),
            apiKeyEnv: value.apiKeyEnv || '',
            models: value.models.map((model) => ({ id: model.id, name: model.name || model.id })),
          };
        }
      }
      return out;
    }

    /** 读 DSH 设置，拿模型清单。 */
    async function fetchDshProviders() {
      const response = await fetch('/api/settings/describe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
          method: 'settings/describe',
          payload: { args: {} },
        }),
      });
      const data = await response.json();
      const namespaces = data?.result?.value?.namespaces || data?.result?.namespaces || [];
      return buildProviders(namespaces);
    }

    /** 多序列折线图：每个目标一条线，自动配色。 */
    function drawChart(canvas, series, unit) {
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || 600;
      const height = canvas.clientHeight || 170;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const all = series.flatMap((item) => item.points.map((point) => point.value)).filter((value) => Number.isFinite(value));
      if (!all.length) return;

      const pad = { l: 48, r: 12, t: 10, b: 22 };
      const plotW = width - pad.l - pad.r;
      const plotH = height - pad.t - pad.b;
      let min = Math.min(...all);
      let max = Math.max(...all);
      if (min === max) {
        min = Math.max(0, min - 1);
        max += 1;
      }
      const margin = (max - min) * 0.15;
      min = Math.max(0, min - margin);
      max += margin;

      const longest = Math.max(...series.map((item) => item.points.length), 1);
      const x = (index) => pad.l + (longest === 1 ? plotW / 2 : (index / (longest - 1)) * plotW);
      const y = (value) => pad.t + plotH - ((value - min) / (max - min)) * plotH;

      ctx.strokeStyle = LINE;
      ctx.fillStyle = TEXT_2;
      ctx.font = '10px sans-serif';
      ctx.lineWidth = 1;
      for (let step = 0; step <= 4; step += 1) {
        const value = min + ((max - min) * step) / 4;
        const lineY = Math.round(y(value)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(pad.l, lineY);
        ctx.lineTo(width - pad.r, lineY);
        ctx.stroke();
        ctx.fillText(String(Math.round(value)), 4, lineY + 3);
      }

      for (const item of series) {
        const points = item.points.filter((point) => Number.isFinite(point.value));
        if (!points.length) continue;
        ctx.strokeStyle = item.color;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        points.forEach((point, index) => (index ? ctx.lineTo(x(index), y(point.value)) : ctx.moveTo(x(index), y(point.value))));
        ctx.stroke();
        ctx.fillStyle = item.color;
        points.forEach((point, index) => {
          ctx.beginPath();
          ctx.arc(x(index), y(point.value), 2, 0, Math.PI * 2);
          ctx.fill();
        });
      }

      const first = series.find((item) => item.points.length)?.points ?? [];
      ctx.fillStyle = TEXT_2;
      ctx.textAlign = 'center';
      [0, Math.floor((first.length - 1) / 2), first.length - 1].forEach((index) => {
        const ts = first[index]?.ts;
        if (!ts) return;
        const label = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        ctx.fillText(label, Math.min(Math.max(x(index), pad.l + 16), width - pad.r - 16), height - 5);
      });
      ctx.textAlign = 'left';
      if (unit) ctx.fillText(unit, pad.l + 4, pad.t + 9);
    }

    /** 面板：配置 + 三张曲线 + 最新值。 */
    function SpeedPanel() {
      const [config, setConfig] = useState({ intervalMinutes: 1, runs: 1, targets: [] });
      const [providers, setProviders] = useState({});
      const [items, setItems] = useState([]);
      const [error, setError] = useState('');
      const [sampling, setSampling] = useState(false);
      const [ready, setReady] = useState(false);
      const ttfbRef = useRef(null);
      const totalRef = useRef(null);
      const tpsRef = useRef(null);

      const pullState = useCallback(async () => {
        const response = await fetch(`${API}/state`, { cache: 'no-store' });
        const data = await response.json();
        setConfig(data.config || { intervalMinutes: 1, runs: 1, targets: [] });
        setProviders(data.providers || {});
        setItems(data.items || []);
        setError(data.error || '');
      }, []);

      // 首次进入：把 DSH 的模型清单推给宿主，再取状态
      useEffect(() => {
        (async () => {
          try {
            const catalog = await fetchDshProviders();
            if (Object.keys(catalog).length) {
              await fetch(`${API}/providers`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ providers: catalog }),
              });
            }
          } catch {
            /* DSH 设置读不到时沿用上次缓存 */
          }
          await pullState();
          setReady(true);
        })();
        const timer = setInterval(() => void pullState(), 30_000);
        return () => clearInterval(timer);
      }, [pullState]);

      const saveConfig = useCallback(async (next) => {
        setConfig(next);
        await fetch(`${API}/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ intervalMinutes: next.intervalMinutes, runs: next.runs, targets: next.targets }),
        });
      }, []);

      const sampleNow = useCallback(async () => {
        setSampling(true);
        try {
          await fetch(`${API}/sample`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          await pullState();
        } finally {
          setSampling(false);
        }
      }, [pullState]);

      const modelOptions = [];
      for (const [providerName, provider] of Object.entries(providers)) {
        for (const model of provider.models || []) {
          modelOptions.push({ key: `${providerName}\u0000${model.id}`, label: `${providerName} / ${model.name}`, provider: providerName, model: model.id });
        }
      }

      const colorOf = (targetId) => PALETTE[Math.max(0, config.targets.findIndex((item) => item.id === targetId)) % PALETTE.length];

      const seriesOf = (pick) => config.targets.map((target) => ({
        id: target.id,
        model: target.model,
        color: colorOf(target.id),
        points: items
          .filter((item) => item.target === target.id)
          .slice(0, 120)
          .reverse()
          .map((item) => ({ ts: item.ts, value: pick(item) })),
      }));

      useEffect(() => {
        if (!ready) return undefined;
        const redraw = () => {
          drawChart(ttfbRef.current, seriesOf((item) => item.ttfb_ms), 'ms');
          drawChart(totalRef.current, seriesOf((item) => item.total_ms), 'ms');
          drawChart(tpsRef.current, seriesOf((item) => item.tps_e2e), 'tok/s');
        };
        redraw();
        window.addEventListener('resize', redraw);
        return () => window.removeEventListener('resize', redraw);
      }, [ready, items, config.targets]);

      const patchTarget = (id, patch) => {
        const next = { ...config, targets: config.targets.map((item) => (item.id === id ? { ...item, ...patch } : item)) };
        void saveConfig(next);
      };

      const addTarget = () => {
        const first = modelOptions[0];
        if (!first) return;
        const next = {
          ...config,
          targets: [...config.targets, { id: `t${Date.now().toString(36)}`, provider: first.provider, model: first.model, effort: 'low' }],
        };
        void saveConfig(next);
      };

      const removeTarget = (id) => {
        void saveConfig({ ...config, targets: config.targets.filter((item) => item.id !== id) });
      };

      const selectStyle = {
        color: TEXT_1,
        background: 'transparent',
        border: `1px solid ${LINE}`,
        borderRadius: 6,
        padding: '3px 6px',
        fontSize: 12,
        maxWidth: 320,
      };

      const latestOf = (targetId) => items.find((item) => item.target === targetId);

      const rows = config.targets.map((target) => {
        const latest = latestOf(target.id);
        return h('div', {
          key: target.id,
          style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', flexWrap: 'wrap' },
        },
          h('span', { style: { width: 8, height: 8, borderRadius: 4, background: colorOf(target.id), flex: 'none' } }),
          h('select', {
            value: `${target.provider}\u0000${target.model}`,
            onChange: (event) => {
              const [provider, model] = event.target.value.split('\u0000');
              patchTarget(target.id, { provider, model });
            },
            style: selectStyle,
          }, modelOptions.map((option) => h('option', { key: option.key, value: option.key }, option.label))),
          h('select', {
            value: target.effort || 'low',
            onChange: (event) => patchTarget(target.id, { effort: event.target.value }),
            style: { ...selectStyle, maxWidth: 110 },
          },
            h('option', { value: 'default' }, `${T.effort}: 默认`),
            h('option', { value: 'none' }, `${T.effort}: off`),
            h('option', { value: 'low' }, `${T.effort}: low`),
            h('option', { value: 'high' }, `${T.effort}: high`),
            h('option', { value: 'max' }, `${T.effort}: max`),
          ),
          h('span', { style: { color: TEXT_2, fontSize: 11, fontVariantNumeric: 'tabular-nums', minWidth: 150 } },
            latest
              ? `${T.ttfb} ${latest.ttfb_ms ?? '--'} ms · ${T.total} ${latest.total_ms ?? '--'} ms`
              : '--'),
          latest?.error ? h('span', { style: { color: BAD, fontSize: 11 } }, latest.error.slice(0, 60)) : null,
          h('button', {
            type: 'button',
            onClick: () => removeTarget(target.id),
            style: { marginLeft: 'auto', background: 'transparent', border: 'none', color: TEXT_2, cursor: 'pointer', fontSize: 11 },
          }, T.remove),
        );
      });

      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minHeight: 0, padding: '18px 22px', overflow: 'auto', color: TEXT_1 },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, T.title),
          h('span', { style: { color: TEXT_2, fontSize: 11 } },
            items[0] ? new Date(items[0].ts).toLocaleString() : ''),
          h('div', { style: { flex: 1 } }),
          h('button', {
            type: 'button',
            onClick: sampleNow,
            disabled: sampling,
            style: { cursor: sampling ? 'default' : 'pointer', padding: '5px 14px', borderRadius: 6, border: `1px solid ${LINE}`, background: 'transparent', color: TEXT_1, fontSize: 12 },
          }, sampling ? T.sampling : T.sample),
        ),
        error ? h('div', { style: { color: BAD, fontSize: 11 } }, error) : null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { color: TEXT_2, fontSize: 11 } }, T.interval),
          h('select', {
            value: String(config.intervalMinutes),
            onChange: (event) => void saveConfig({ ...config, intervalMinutes: Number(event.target.value) }),
            style: selectStyle,
          },
            [1, 2, 5, 10, 30].map((minute) => h('option', { key: minute, value: String(minute) }, `${minute} ${T.minutes}`)),
          ),
          h('span', { style: { color: TEXT_2, fontSize: 11 }, }, T.models),
          h('button', {
            type: 'button',
            onClick: addTarget,
            disabled: !modelOptions.length,
            style: { cursor: modelOptions.length ? 'pointer' : 'default', padding: '3px 10px', borderRadius: 6, border: `1px solid ${LINE}`, background: 'transparent', color: TEXT_1, fontSize: 11 },
          }, `+ ${T.add}`),
        ),
        modelOptions.length === 0 ? h('div', { style: { color: TEXT_2, fontSize: 11 } }, T.empty) : null,
        config.targets.length === 0
          ? h('div', { style: { color: TEXT_2, fontSize: 11 } }, T.noTargets)
          : h('div', { style: { display: 'flex', flexDirection: 'column' } }, rows),
        h('div', { style: { display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 4 } },
          h('div', { style: { flex: '1 1 280px', minWidth: 260 } },
            h('div', { style: { color: TEXT_2, fontSize: 11, marginBottom: 4 } }, T.chartTtfb),
            h('canvas', { ref: ttfbRef, style: { width: '100%', height: 160, display: 'block' } })),
          h('div', { style: { flex: '1 1 280px', minWidth: 260 } },
            h('div', { style: { color: TEXT_2, fontSize: 11, marginBottom: 4 } }, T.chartTotal),
            h('canvas', { ref: totalRef, style: { width: '100%', height: 160, display: 'block' } })),
          h('div', { style: { flex: '1 1 280px', minWidth: 260 } },
            h('div', { style: { color: TEXT_2, fontSize: 11, marginBottom: 4 } }, T.chartTps),
            h('canvas', { ref: tpsRef, style: { width: '100%', height: 160, display: 'block' } })),
        ),
        h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', color: TEXT_2, fontSize: 11 } },
          config.targets.map((target) => h('span', { key: target.id, style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
            h('span', { style: { width: 8, height: 8, borderRadius: 4, background: colorOf(target.id) } }),
            `${target.model}`)),
        ),
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
        const disposers = [];
        disposers.push(ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 45, label: () => T.label }, PanelIcon));
        disposers.push(ctx.slots.register({ name: 'main', key: PANEL_ID }, SpeedPanel));
        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              /* 卸载时忽略 */
            }
          }
        };
      })), 'dsh-speed-monitor: slots');
    }

    /** 侧栏入口图标：仪表盘。 */
    function PanelIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M4 16.5a8.5 8.5 0 1 1 17 0' }),
        h('path', { d: 'M12 16.5l5.2-6.4' }),
        h('circle', { cx: 12, cy: 16.5, r: 1.4, fill: 'currentColor', stroke: 'none' }),
      );
    }

    return { inject: ['slots'], apply };
  },
});
