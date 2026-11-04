/**
 * Client half of dsh-speed-monitor.
 *
 * 侧栏入口（sidebar.panellist）+ 右侧面板（main）：
 * 用 DSH 自己的模型清单测流式速度，默认每分钟一轮，多模型并列；
 * 一张图、每个模型一条线，顶部切换指标（首字节 / 总耗时 / 吞吐），悬浮看该点三项数值。
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
    const LINK = 'var(--dsw-alias-border-l2, #2a3038)';
    const CARD_FILL = 'color-mix(in srgb, currentColor 5%, transparent)';
    const BAD = '#ff6262';
    const PALETTE = ['#43c982', '#5aa9ff', '#efb83f', '#c47bff', '#ff8f6b', '#4dd0c4'];

    /** 三个可切换的指标。 */
    const METRICS = [
      { key: 'ttfb', label: '首字节', field: 'ttfb_ms', unit: 'ms' },
      { key: 'total', label: '总耗时', field: 'total_ms', unit: 'ms' },
      { key: 'tps', label: '吞吐', field: 'tps_e2e', unit: 'tok/s' },
    ];

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
      empty: 'DSH 里还没有配置模型',
      noTargets: '点「添加模型」开始测速',
      ttfb: '首字节',
      total: '总耗时',
      tps: '吞吐',
      noData: '暂无数据，等待下一轮采样或点「立即采样」',
      hoverHint: '悬浮查看该次采样的三项数值',
    };

    /** 从 DSH 设置里解析供应商与模型。 */
    function buildProviders(namespaces) {
      const out = {};
      for (const entry of namespaces || []) {
        const ns = String(entry?.ns || '');
        if (!ns.startsWith('llm-')) continue;
        const value = entry?.value || {};

        if (value.providers && typeof value.providers === 'object') {
          for (const [name, provider] of Object.entries(value.providers)) {
            if (!provider?.models?.length) continue;
            const models = [];
            const seen = new Set();
            for (const model of provider.models) {
              if (!model?.id || seen.has(model.id)) continue;
              seen.add(model.id);
              models.push({ id: model.id, name: model.name || model.id });
            }
            if (!models.length) continue;
            out[name] = {
              baseURL: provider.baseURL || '',
              apiKeyEnv: provider.apiKeyEnv || '',
              displayName: provider.displayName || name,
              models,
            };
          }
        } else if (Array.isArray(value.models) && value.models.length) {
          const name = ns === 'llm-deepseek' ? 'deepseek-official' : ns.replace(/^llm-/, '');
          const models = [];
          const seen = new Set();
          for (const model of value.models) {
            if (!model?.id || seen.has(model.id)) continue;
            seen.add(model.id);
            models.push({ id: model.id, name: model.name || model.id });
          }
          if (!models.length) continue;
          out[name] = {
            baseURL: value.baseURL || (ns === 'llm-deepseek' ? 'https://api.deepseek.com' : ''),
            apiKeyEnv: value.apiKeyEnv || '',
            displayName: ns === 'llm-deepseek' ? 'DeepSeek' : name,
            models,
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

    /** 圆整刻度步长。 */
    function niceStep(span, count) {
      const rough = span / count;
      const power = Math.pow(10, Math.floor(Math.log10(rough || 1)));
      const ratio = rough / power;
      const step = ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 2.5 ? 2.5 : ratio <= 5 ? 5 : 10;
      return step * power;
    }

    /** 解析 canvas 所在主题的实际颜色（canvas 不认 CSS 变量）。 */
    function themeColors(element) {
      const style = getComputedStyle(element);
      const token = (name, fallback) => {
        const value = style.getPropertyValue(name).trim();
        return value && !value.startsWith('var(') ? value : fallback;
      };
      const text = token('--dsw-alias-label-primary', '#e6e9ee');
      const muted = token('--dsw-alias-label-secondary', '#9aa3b2');
      const border = token('--dsw-alias-border-l3', 'rgba(140, 150, 165, 0.45)');
      const rgb = /rgba?\(([^)]+)\)/.exec(text);
      const hex = /^#([0-9a-f]{3,8})$/i.exec(text);
      let parts = [230, 233, 238];
      if (rgb) parts = rgb[1].split(',').slice(0, 3).map((value) => Number(value.trim()));
      else if (hex) {
        const raw = hex[1];
        parts = raw.length === 3
          ? raw.split('').map((ch) => parseInt(ch + ch, 16))
          : [raw.slice(0, 2), raw.slice(2, 4), raw.slice(4, 6)].map((ch) => parseInt(ch, 16));
      }
      if (parts.some((value) => !Number.isFinite(value))) parts = [230, 233, 238];
      const luminance = (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255;
      const dark = luminance >= 0.5;
      return {
        muted,
        border,
        grid: dark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(15, 17, 21, 0.07)',
        axisText: dark ? 'rgba(255, 255, 255, 0.55)' : 'rgba(15, 17, 21, 0.55)',
        tipFill: dark ? 'rgba(30, 33, 39, 0.97)' : 'rgba(255, 255, 255, 0.98)',
        tipStroke: dark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(15, 17, 21, 0.14)',
        tipText: dark ? '#e8ebf0' : '#14171c',
        tipMuted: dark ? '#a8b0bd' : '#5b6472',
      };
    }

    /** 单指标折线：每个模型一条线，自动取整刻度；hover 时画十字线与浮窗。 */
    function drawChart(canvas, series, unit, hover, progress) {
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || 700;
      const height = canvas.clientHeight || 240;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const colors = themeColors(canvas);

      const values = [];
      for (const item of series) {
        for (const point of item.points) {
          if (Number.isFinite(point.value)) values.push(point.value);
        }
      }
      if (!values.length) {
        ctx.fillStyle = colors.muted;
        ctx.font = '12px sans-serif';
        ctx.fillText(T.noData, 12, 28);
        return;
      }

      const rawMax = Math.max(1, ...values);
      const step = niceStep(rawMax, 4);
      const max = Math.max(step, Math.ceil((rawMax * 1.08) / step) * step);
      ctx.font = '10px sans-serif';
      const ticks = [];
      for (let value = 0; value <= max + 1e-9; value += step) ticks.push(Math.round(value));
      const leftWidth = Math.max(...ticks.map((value) => ctx.measureText(String(value)).width)) + 16;

      const pad = { l: leftWidth, r: 16, t: 26, b: 24 };
      const plotW = Math.max(40, width - pad.l - pad.r);
      const plotH = Math.max(40, height - pad.t - pad.b);
      const longest = Math.max(...series.map((item) => item.points.length), 1);
      const x = (index) => pad.l + (longest === 1 ? plotW / 2 : (index / (longest - 1)) * plotW);
      const y = (value) => pad.t + plotH - (value / max) * plotH;
      canvas.__geometry = { pad, plotW, plotH, longest };

      ctx.textBaseline = 'middle';
      for (const value of ticks) {
        const lineY = Math.round(y(value)) + 0.5;
        ctx.strokeStyle = colors.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad.l, lineY);
        ctx.lineTo(width - pad.r, lineY);
        ctx.stroke();
        ctx.fillStyle = colors.axisText;
        ctx.textAlign = 'right';
        ctx.fillText(String(value), pad.l - 8, lineY);
      }
      ctx.textBaseline = 'alphabetic';

      ctx.strokeStyle = colors.border;
      ctx.beginPath();
      ctx.moveTo(pad.l + 0.5, pad.t);
      ctx.lineTo(pad.l + 0.5, pad.t + plotH);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pad.l, pad.t + plotH + 0.5);
      ctx.lineTo(width - pad.r, pad.t + plotH + 0.5);
      ctx.stroke();

      ctx.fillStyle = colors.axisText;
      ctx.textAlign = 'right';
      ctx.fillText(unit, width - 4, pad.t - 10);

      const firstPoints = series.find((item) => item.points.length)?.points ?? [];
      const indexes = [0, Math.floor((firstPoints.length - 1) / 2), firstPoints.length - 1]
        .filter((value, index, list) => value >= 0 && list.indexOf(value) === index);
      ctx.textAlign = 'center';
      indexes.forEach((index) => {
        const ts = firstPoints[index]?.ts;
        if (!ts) return;
        const px = Math.min(Math.max(x(index), pad.l + 16), width - pad.r - 16);
        ctx.strokeStyle = colors.grid;
        ctx.beginPath();
        ctx.moveTo(Math.round(px) + 0.5, pad.t);
        ctx.lineTo(Math.round(px) + 0.5, pad.t + plotH);
        ctx.stroke();
        ctx.fillStyle = colors.axisText;
        ctx.fillText(new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), px, height - 6);
      });
      ctx.textAlign = 'left';

      const reveal = Math.max(0, Math.min(1, progress ?? 1));
      ctx.save();
      ctx.beginPath();
      ctx.rect(pad.l - 1, pad.t - 1, plotW * reveal + 1, plotH + 2);
      ctx.clip();
      for (const item of series) {
        const points = item.points.map((point, index) => ({ index, value: point.value })).filter((point) => Number.isFinite(point.value));
        if (!points.length) continue;
        if (points.length >= 2) {
          const gradient = ctx.createLinearGradient(0, pad.t, 0, pad.t + plotH);
          gradient.addColorStop(0, `${item.color}33`);
          gradient.addColorStop(1, `${item.color}00`);
          ctx.fillStyle = gradient;
          ctx.beginPath();
          points.forEach((point, index) => (index ? ctx.lineTo(x(point.index), y(point.value)) : ctx.moveTo(x(point.index), y(point.value))));
          ctx.lineTo(x(points[points.length - 1].index), pad.t + plotH);
          ctx.lineTo(x(points[0].index), pad.t + plotH);
          ctx.closePath();
          ctx.fill();
        }
        ctx.strokeStyle = item.color;
        ctx.lineWidth = 1.9;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        points.forEach((point, index) => (index ? ctx.lineTo(x(point.index), y(point.value)) : ctx.moveTo(x(point.index), y(point.value))));
        ctx.stroke();
        if (points.length === 1) {
          ctx.fillStyle = item.color;
          ctx.beginPath();
          ctx.arc(x(points[0].index), y(points[0].value), 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();

      if (hover && hover.index >= 0 && firstPoints[hover.index]) {
        const px = x(hover.index);
        ctx.strokeStyle = colors.border;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(Math.round(px) + 0.5, pad.t);
        ctx.lineTo(Math.round(px) + 0.5, pad.t + plotH);
        ctx.stroke();
        ctx.setLineDash([]);

        const lines = [];
        for (const item of series) {
          const point = item.points[hover.index];
          if (!point) continue;
          if (Number.isFinite(point.value)) {
            ctx.fillStyle = colors.tipFill;
            ctx.strokeStyle = item.color;
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.arc(px, y(point.value), 3.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
          lines.push({ color: item.color, text: item.model, detail: point.detail });
        }

        if (lines.length) {
          ctx.font = '11px sans-serif';
          const timeLabel = new Date(firstPoints[hover.index].ts).toLocaleTimeString();
          const textWidth = Math.max(
            ctx.measureText(timeLabel).width,
            ...lines.map((line) => ctx.measureText(`${line.text}  ${line.detail}`).width),
          ) + 30;
          const boxW = Math.min(textWidth, width - 24);
          const boxH = 24 + lines.length * 16;
          let boxX = px + 12;
          if (boxX + boxW > width - 8) boxX = px - boxW - 12;
          boxX = Math.max(8, boxX);
          let boxY = pad.t + 6;
          if (boxY + boxH > pad.t + plotH) boxY = pad.t + plotH - boxH;

          ctx.fillStyle = colors.tipFill;
          ctx.strokeStyle = colors.tipStroke;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(boxX, boxY, boxW, boxH, 8);
          else ctx.rect(boxX, boxY, boxW, boxH);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = colors.tipMuted;
          ctx.textAlign = 'left';
          ctx.fillText(timeLabel, boxX + 10, boxY + 16);
          lines.forEach((line, index) => {
            const rowY = boxY + 16 + (index + 1) * 16;
            ctx.fillStyle = line.color;
            ctx.beginPath();
            ctx.arc(boxX + 13, rowY - 3, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = colors.tipText;
            ctx.fillText(`${line.text}  ${line.detail}`, boxX + 21, rowY);
          });
        }
      }
    }

    /** 面板：配置 + 单指标曲线 + 最新值。 */
    function SpeedPanel() {
      const [config, setConfig] = useState({ intervalMinutes: 1, runs: 1, targets: [] });
      const [providers, setProviders] = useState({});
      const [items, setItems] = useState([]);
      const [error, setError] = useState('');
      const [sampling, setSampling] = useState(false);
      const [ready, setReady] = useState(false);
      const [metric, setMetric] = useState('ttfb');
      const chartRef = useRef(null);
      const hoverRef = useRef({ index: -1 });
      const frameRef = useRef(0);

      const pullState = useCallback(async () => {
        const response = await fetch(`${API}/state`, { cache: 'no-store' });
        const data = await response.json();
        setConfig(data.config || { intervalMinutes: 1, runs: 1, targets: [] });
        setProviders(data.providers || {});
        setItems(data.items || []);
        setError(data.error || '');
      }, []);

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
            /* 读不到设置时沿用缓存 */
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
          modelOptions.push({
            key: `${providerName}\u0000${model.id}`,
            label: `${provider.displayName || providerName} · ${model.name}`,
            provider: providerName,
            model: model.id,
          });
        }
      }

      const colorOf = (targetId) => PALETTE[Math.max(0, config.targets.findIndex((item) => item.id === targetId)) % PALETTE.length];
      const metricDef = METRICS.find((item) => item.key === metric) || METRICS[0];

      // 只取「同一 target 且同一模型」的记录：切换模型后旧模型的历史不会混进来
      const series = config.targets.map((target) => {
        const provider = providers[target.provider];
        const modelName = provider?.models?.find((model) => model.id === target.model)?.name || target.model;
        const rows = items
          .filter((item) => item.target === target.id && item.model === target.model)
          .slice(0, 120)
          .reverse();
        return {
          id: target.id,
          model: modelName,
          color: colorOf(target.id),
          points: rows.map((item) => ({
            ts: item.ts,
            value: item[metricDef.field],
            detail: `${item.ttfb_ms ?? '--'} / ${item.total_ms ?? '--'} ms · ${item.tps_e2e ?? '--'} tok/s`,
          })),
        };
      });

      useEffect(() => {
        if (!ready) return undefined;
        drawChart(chartRef.current, series, metricDef.unit, hoverRef.current, 1);
        let start = 0;
        const duration = 280;
        const tick = (time) => {
          if (!start) start = time;
          const ratio = Math.min(1, (time - start) / duration);
          drawChart(chartRef.current, series, metricDef.unit, hoverRef.current, ratio);
          if (ratio < 1) frameRef.current = requestAnimationFrame(tick);
        };
        frameRef.current = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frameRef.current);
      }, [ready, items, config.targets, metric]);

      const handleMove = useCallback((event) => {
        const canvas = chartRef.current;
        const geometry = canvas?.__geometry;
        if (!canvas || !geometry) return;
        const rect = canvas.getBoundingClientRect();
        const ratio = (event.clientX - rect.left - geometry.pad.l) / geometry.plotW;
        const index = Math.round(ratio * (geometry.longest - 1));
        hoverRef.current = { index: Math.max(0, Math.min(geometry.longest - 1, index)) };
        drawChart(canvas, series, metricDef.unit, hoverRef.current, 1);
      }, [series, metricDef]);

      const handleLeave = useCallback(() => {
        hoverRef.current = { index: -1 };
        drawChart(chartRef.current, series, metricDef.unit, { index: -1 }, 1);
      }, [series, metricDef]);

      const patchTarget = (id, patch) => {
        void saveConfig({ ...config, targets: config.targets.map((item) => (item.id === id ? { ...item, ...patch } : item)) });
      };

      const addTarget = () => {
        const first = modelOptions[0];
        if (!first) return;
        void saveConfig({
          ...config,
          targets: [...config.targets, { id: `t${Date.now().toString(36)}`, provider: first.provider, model: first.model, effort: 'low' }],
        });
      };

      const removeTarget = (id) => {
        void saveConfig({ ...config, targets: config.targets.filter((item) => item.id !== id) });
      };

      const controlStyle = {
        color: TEXT_1,
        background: 'var(--dsw-alias-settings-card-fill, transparent)',
        border: '1px solid var(--dsw-alias-settings-card-stroke, rgba(255,255,255,0.12))',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        padding: '4px 8px',
        fontSize: 12,
        lineHeight: '18px',
        maxWidth: 340,
        cursor: 'pointer',
      };

      const primaryButton = {
        cursor: sampling ? 'default' : 'pointer',
        padding: '5px 14px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-button-primary-fill, #2b6cff)',
        color: 'var(--dsw-alias-label-primary-foreground, #fff)',
        fontSize: 12,
        lineHeight: '18px',
        opacity: sampling ? 0.6 : 1,
      };

      const ghostButton = {
        cursor: modelOptions.length ? 'pointer' : 'default',
        padding: '4px 10px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        border: '1px solid var(--dsw-alias-settings-card-stroke, rgba(255,255,255,0.12))',
        background: 'transparent',
        color: modelOptions.length ? TEXT_1 : TEXT_2,
        fontSize: 11,
        lineHeight: '16px',
      };

      const metricButton = (item) => ({
        cursor: 'pointer',
        padding: '3px 10px',
        borderRadius: 999,
        border: `1px solid ${metric === item.key ? 'transparent' : LINK}`,
        background: metric === item.key ? 'var(--dsw-alias-button-primary-fill, #2b6cff)' : 'transparent',
        color: metric === item.key ? 'var(--dsw-alias-label-primary-foreground, #fff)' : TEXT_2,
        fontSize: 11,
        lineHeight: '16px',
      });

      const latestFor = (target) => items.find((item) => item.target === target.id && item.model === target.model);

      const rows = config.targets.map((target) => {
        const latest = latestFor(target);
        return h('div', {
          key: target.id,
          style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 8, background: CARD_FILL, flexWrap: 'wrap' },
        },
          h('span', { style: { width: 8, height: 8, borderRadius: 4, background: colorOf(target.id), flex: 'none' } }),
          h('select', {
            value: `${target.provider}\u0000${target.model}`,
            onChange: (event) => {
              const [provider, model] = event.target.value.split('\u0000');
              patchTarget(target.id, { provider, model });
            },
            style: controlStyle,
          }, modelOptions.map((option) => h('option', { key: option.key, value: option.key }, option.label))),
          h('select', {
            value: target.effort || 'low',
            onChange: (event) => patchTarget(target.id, { effort: event.target.value }),
            style: { ...controlStyle, maxWidth: 116 },
          },
            h('option', { value: 'default' }, `${T.effort}: 默认`),
            h('option', { value: 'none' }, `${T.effort}: off`),
            h('option', { value: 'low' }, `${T.effort}: low`),
            h('option', { value: 'high' }, `${T.effort}: high`),
            h('option', { value: 'max' }, `${T.effort}: max`),
          ),
          h('span', { style: { color: TEXT_2, fontSize: 11, fontVariantNumeric: 'tabular-nums', minWidth: 210 } },
            latest
              ? `${T.ttfb} ${latest.ttfb_ms ?? '--'} ms · ${T.total} ${latest.total_ms ?? '--'} ms · ${latest.tps_e2e ?? '--'} tok/s`
              : '--'),
          latest?.error ? h('span', { style: { color: BAD, fontSize: 11 } }, latest.error.slice(0, 60)) : null,
          h('button', {
            type: 'button',
            onClick: () => removeTarget(target.id),
            style: { marginLeft: 'auto', background: 'transparent', border: 'none', color: TEXT_2, cursor: 'pointer', fontSize: 11, padding: '2px 4px' },
          }, T.remove),
        );
      });

      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minHeight: 0, padding: '18px 22px', overflow: 'auto', color: TEXT_1 },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, T.title),
          h('span', { style: { color: TEXT_2, fontSize: 11 } }, items[0] ? new Date(items[0].ts).toLocaleString() : ''),
          h('div', { style: { flex: 1 } }),
          h('button', { type: 'button', onClick: sampleNow, disabled: sampling, style: primaryButton }, sampling ? T.sampling : T.sample),
        ),
        error ? h('div', { style: { color: BAD, fontSize: 11 } }, error) : null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { color: TEXT_2, fontSize: 11 } }, T.interval),
          h('select', {
            value: String(config.intervalMinutes),
            onChange: (event) => void saveConfig({ ...config, intervalMinutes: Number(event.target.value) }),
            style: controlStyle,
          }, [1, 2, 5, 10, 30].map((minute) => h('option', { key: minute, value: String(minute) }, `${minute} ${T.minutes}`))),
          h('span', { style: { color: TEXT_2, fontSize: 11 } }, T.models),
          h('button', { type: 'button', onClick: addTarget, disabled: !modelOptions.length, style: ghostButton }, `+ ${T.add}`),
          h('div', { style: { flex: 1 } }),
          h('div', { style: { display: 'flex', gap: 6 } }, METRICS.map((item) =>
            h('button', { key: item.key, type: 'button', onClick: () => setMetric(item.key), style: metricButton(item) }, item.label))),
        ),
        modelOptions.length === 0 ? h('div', { style: { color: TEXT_2, fontSize: 11 } }, T.empty) : null,
        config.targets.length === 0
          ? h('div', { style: { color: TEXT_2, fontSize: 11 } }, T.noTargets)
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, rows),
        h('div', { style: { marginTop: 4 } },
          h('canvas', {
            ref: chartRef,
            onMouseMove: handleMove,
            onMouseLeave: handleLeave,
            style: { width: '100%', height: 240, display: 'block', cursor: 'crosshair' },
          }),
          h('div', { style: { color: TEXT_2, fontSize: 11, marginTop: 4 } },
            `${metricDef.label}（${metricDef.unit}）· 每个模型一条线 · ${T.hoverHint}`),
        ),
        h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', color: TEXT_2, fontSize: 11 } },
          series.map((item) => h('span', { key: item.id, style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
            h('span', { style: { width: 8, height: 8, borderRadius: 4, background: item.color } }),
            item.model)),
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
