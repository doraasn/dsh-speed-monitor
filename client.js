/**
 * Client half of dsh-speed-monitor.
 *
 * 侧栏入口（sidebar.panellist）+ 右侧面板（main）：
 * 用 DSH 自己的模型清单测流式速度，默认每分钟一轮，多模型并列，
 * 指标合成一张双轴图（左 ms / 右 tok/s），支持悬浮十字线与数值浮窗。
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
    const CARD_FILL = 'color-mix(in srgb, currentColor 5%, transparent)';
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
      empty: 'DSH 里还没有配置模型',
      noTargets: '点「添加模型」开始测速',
      ttfb: '首字节',
      total: '总耗时',
      tps: '吞吐',
      chartTitle: '总览（左轴 ms · 右轴 tok/s）',
      chartNote: '实线 首字节 · 虚线 总耗时（左轴 ms）· 点线 吞吐（右轴 tok/s）· 悬浮查看数值',
    };

    /** 从 DSH 设置里解析供应商与模型：llm-pi-ai.providers 与 llm-deepseek.models。 */
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

    /** 圆整刻度步长：1 / 2 / 2.5 / 5 × 10^n。 */
    function niceStep(span, count) {
      const rough = span / count;
      const power = Math.pow(10, Math.floor(Math.log10(rough || 1)));
      const ratio = rough / power;
      const step = ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 2.5 ? 2.5 : ratio <= 5 ? 5 : 10;
      return step * power;
    }

    /** 解析 canvas 所在主题的实际颜色；canvas 不认 CSS 变量。 */
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
      const parts = rgb ? rgb[1].split(',').map((value) => Number(value.trim())) : [230, 233, 238];
      const luminance = (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255;
      const dark = luminance < 0.5;
      return {
        text,
        muted,
        border,
        grid: dark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(15, 17, 21, 0.07)',
        axisText: dark ? 'rgba(255, 255, 255, 0.55)' : 'rgba(15, 17, 21, 0.55)',
        bg: dark ? 'rgba(255, 255, 255, 0.015)' : 'rgba(15, 17, 21, 0.015)',
        tipFill: dark ? 'rgba(30, 33, 39, 0.97)' : 'rgba(255, 255, 255, 0.98)',
        tipStroke: dark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(15, 17, 21, 0.14)',
        tipText: dark ? '#e8ebf0' : '#14171c',
        tipMuted: dark ? '#a8b0bd' : '#5b6472',
      };
    }

    /** 单画布双区：上区时延（ms，首字节实线 / 总耗时细线），下区吞吐（tok/s 虚线），共用时间轴。 */
    function drawCombined(canvas, series, hover, progress) {
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || 700;
      const height = canvas.clientHeight || 230;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const colors = themeColors(canvas);

      const lat = [];
      const tps = [];
      for (const item of series) {
        for (const point of item.points) {
          if (Number.isFinite(point.ttfb)) lat.push(point.ttfb);
          if (Number.isFinite(point.total)) lat.push(point.total);
          if (Number.isFinite(point.tps)) tps.push(point.tps);
        }
      }
      if (!lat.length && !tps.length) {
        ctx.fillStyle = colors.muted;
        ctx.font = '12px sans-serif';
        ctx.fillText('暂无数据', 16, 26);
        return;
      }

      const latRaw = Math.max(1, ...lat);
      const tpsRaw = Math.max(1, ...tps);
      const latStep = niceStep(latRaw, 4);
      const tpsStep = niceStep(tpsRaw, 2);
      const latMax = Math.max(latStep, Math.ceil((latRaw * 1.08) / latStep) * latStep);
      const tpsMax = Math.max(tpsStep, Math.ceil((tpsRaw * 1.15) / tpsStep) * tpsStep);

      ctx.font = '10px sans-serif';
      const tpsTicks = [];
      for (let value = 0; value <= tpsMax + 1e-9; value += tpsStep) tpsTicks.push(Math.round(value));
      const rightWidth = Math.max(...tpsTicks.map((value) => ctx.measureText(String(value)).width)) + 14;
      const latTicks = [];
      for (let value = 0; value <= latMax + 1e-9; value += latStep) latTicks.push(Math.round(value));
      const leftWidth = Math.max(...latTicks.map((value) => ctx.measureText(String(value)).width)) + 14;

      const pad = { l: leftWidth, r: rightWidth, t: 38, b: 22 };
      const gap = 22;
      const contentH = Math.max(60, height - pad.t - pad.b - gap);
      const latH = Math.round(contentH * 0.68);
      const tpsH = contentH - latH;
      const plotW = Math.max(40, width - pad.l - pad.r);
      const latTop = pad.t;
      const tpsTop = pad.t + latH + gap;
      const longest = Math.max(...series.map((item) => item.points.length), 1);
      const x = (index) => pad.l + (longest === 1 ? plotW / 2 : (index / (longest - 1)) * plotW);
      const yLat = (value) => latTop + latH - (value / latMax) * latH;
      const yTps = (value) => tpsTop + tpsH - (value / tpsMax) * tpsH;
      canvas.__geometry = { pad, plotW, plotH: latH + gap + tpsH, longest };

      // 上区网格与左轴
      ctx.textBaseline = 'middle';
      for (const value of latTicks) {
        const lineY = Math.round(yLat(value)) + 0.5;
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

      // 下区网格与右轴
      ctx.textAlign = 'left';
      for (const value of tpsTicks) {
        const lineY = Math.round(yTps(value)) + 0.5;
        ctx.strokeStyle = colors.grid;
        ctx.beginPath();
        ctx.moveTo(pad.l, lineY);
        ctx.lineTo(width - pad.r, lineY);
        ctx.stroke();
        ctx.fillStyle = colors.axisText;
        ctx.fillText(String(value), width - pad.r + 8, lineY);
      }
      ctx.textBaseline = 'alphabetic';

      // 轴线
      ctx.strokeStyle = colors.border;
      ctx.beginPath();
      ctx.moveTo(pad.l + 0.5, latTop);
      ctx.lineTo(pad.l + 0.5, latTop + latH);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pad.l + 0.5, tpsTop);
      ctx.lineTo(pad.l + 0.5, tpsTop + tpsH);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(width - pad.r + 0.5, tpsTop);
      ctx.lineTo(width - pad.r + 0.5, tpsTop + tpsH);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pad.l, tpsTop + tpsH + 0.5);
      ctx.lineTo(width - pad.r, tpsTop + tpsH + 0.5);
      ctx.stroke();

      // 区标题
      ctx.fillStyle = colors.axisText;
      ctx.textAlign = 'left';
      ctx.textAlign = 'right';
      ctx.fillText('ms', width - pad.r - 4, latTop - 8);
      ctx.fillText('tok/s', width - pad.r - 4, tpsTop - 8);
      ctx.textAlign = 'left';

      // 时间轴
      const first = series.find((item) => item.points.length)?.points ?? [];
      const indexes = [0, Math.floor((first.length - 1) / 2), first.length - 1]
        .filter((value, index, list) => value >= 0 && list.indexOf(value) === index);
      ctx.textAlign = 'center';
      indexes.forEach((index) => {
        const ts = first[index]?.ts;
        if (!ts) return;
        const px = Math.min(Math.max(x(index), pad.l + 16), width - pad.r - 16);
        ctx.strokeStyle = colors.grid;
        ctx.beginPath();
        ctx.moveTo(Math.round(px) + 0.5, latTop);
        ctx.lineTo(Math.round(px) + 0.5, latTop + latH);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(Math.round(px) + 0.5, tpsTop);
        ctx.lineTo(Math.round(px) + 0.5, tpsTop + tpsH);
        ctx.stroke();
        ctx.fillStyle = colors.axisText;
        ctx.fillText(new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), px, height - 5);
      });
      ctx.textAlign = 'left';

      const reveal = Math.max(0, Math.min(1, progress ?? 1));
      ctx.save();
      ctx.beginPath();
      ctx.rect(pad.l - 1, latTop - 1, plotW * reveal + 1, latH + gap + tpsH + 2);
      ctx.clip();

      // 首字节下方铺一层极淡的色块，让主次更清楚
      for (const item of series) {
        const points = item.points.map((point, index) => ({ index, value: point.ttfb })).filter((point) => Number.isFinite(point.value));
        if (points.length < 2) continue;
        const gradient = ctx.createLinearGradient(0, latTop, 0, latTop + latH);
        gradient.addColorStop(0, `${item.color}33`);
        gradient.addColorStop(1, `${item.color}00`);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        points.forEach((point, index) => (index ? ctx.lineTo(x(point.index), yLat(point.value)) : ctx.moveTo(x(point.index), yLat(point.value))));
        ctx.lineTo(x(points[points.length - 1].index), latTop + latH);
        ctx.lineTo(x(points[0].index), latTop + latH);
        ctx.closePath();
        ctx.fill();
      }

      const line = (item, pick, scale, dash, widthPx, alpha) => {
        const points = item.points.map((point, index) => ({ index, value: pick(point) })).filter((point) => Number.isFinite(point.value));
        if (!points.length) return;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = item.color;
        ctx.lineWidth = widthPx;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.setLineDash(dash);
        ctx.beginPath();
        points.forEach((point, index) => (index ? ctx.lineTo(x(point.index), scale(point.value)) : ctx.moveTo(x(point.index), scale(point.value))));
        ctx.stroke();
        ctx.restore();
      };

      for (const item of series) {
        line(item, (point) => point.total, yLat, [], 1, 0.4);
        line(item, (point) => point.ttfb, yLat, [], 1.9, 1);
        line(item, (point) => point.tps, yTps, [], 1.4, 0.85);
      }
      ctx.restore();

      if (hover && hover.index >= 0 && first[hover.index]) {
        const px = x(hover.index);
        ctx.strokeStyle = colors.border;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(Math.round(px) + 0.5, latTop);
        ctx.lineTo(Math.round(px) + 0.5, tpsTop + tpsH);
        ctx.stroke();
        ctx.setLineDash([]);

        const lines = [];
        for (const item of series) {
          const point = item.points[hover.index];
          if (!point) continue;
          if (Number.isFinite(point.ttfb)) {
            ctx.fillStyle = colors.tipFill;
            ctx.strokeStyle = item.color;
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.arc(px, yLat(point.ttfb), 3.4, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
          if (Number.isFinite(point.tps)) {
            ctx.fillStyle = item.color;
            ctx.beginPath();
            ctx.arc(px, yTps(point.tps), 2.2, 0, Math.PI * 2);
            ctx.fill();
          }
          lines.push({
            color: item.color,
            text: `${item.model}  ${Number.isFinite(point.ttfb) ? point.ttfb : '--'} / ${Number.isFinite(point.total) ? point.total : '--'} ms · ${Number.isFinite(point.tps) ? point.tps : '--'} tok/s`,
          });
        }

        if (lines.length) {
          ctx.font = '11px sans-serif';
          const timeLabel = new Date(first[hover.index].ts).toLocaleTimeString();
          const textWidth = Math.max(ctx.measureText(timeLabel).width, ...lines.map((line) => ctx.measureText(line.text).width)) + 30;
          const boxW = Math.min(textWidth, width - 24);
          const boxH = 24 + lines.length * 16;
          let boxX = px + 12;
          if (boxX + boxW > width - 8) boxX = px - boxW - 12;
          boxX = Math.max(8, boxX);
          let boxY = latTop + 6;
          if (boxY + boxH > latTop + latH) boxY = Math.max(8, latTop + latH - boxH);

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
            ctx.fillText(line.text, boxX + 21, rowY);
          });
        }
      }
    }

    /** 面板：配置 + 双轴曲线 + 最新值。 */
    function SpeedPanel() {
      const [config, setConfig] = useState({ intervalMinutes: 1, runs: 1, targets: [] });
      const [providers, setProviders] = useState({});
      const [items, setItems] = useState([]);
      const [error, setError] = useState('');
      const [sampling, setSampling] = useState(false);
      const [ready, setReady] = useState(false);
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
          modelOptions.push({
            key: `${providerName}\u0000${model.id}`,
            label: `${provider.displayName || providerName} · ${model.name}`,
            provider: providerName,
            model: model.id,
          });
        }
      }

      const colorOf = (targetId) => PALETTE[Math.max(0, config.targets.findIndex((item) => item.id === targetId)) % PALETTE.length];

      const series = config.targets.map((target) => {
        const provider = providers[target.provider];
        const modelName = provider?.models?.find((model) => model.id === target.model)?.name || target.model;
        return {
          id: target.id,
          model: modelName,
          color: colorOf(target.id),
          points: items
            .filter((item) => item.target === target.id)
            .slice(0, 120)
            .reverse()
            .map((item) => ({ ts: item.ts, ttfb: item.ttfb_ms, total: item.total_ms, tps: item.tps_e2e })),
        };
      });

      useEffect(() => {
        if (!ready) return undefined;
        drawCombined(chartRef.current, series, hoverRef.current, 1);
        let start = 0;
        const duration = 320;
        const tick = (time) => {
          if (!start) start = time;
          const ratio = Math.min(1, (time - start) / duration);
          drawCombined(chartRef.current, series, hoverRef.current, ratio);
          if (ratio < 1) frameRef.current = requestAnimationFrame(tick);
        };
        frameRef.current = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frameRef.current);
      }, [ready, items, config.targets]);

      const handleMove = useCallback((event) => {
        const canvas = chartRef.current;
        const geometry = canvas?.__geometry;
        if (!canvas || !geometry) return;
        const rect = canvas.getBoundingClientRect();
        const ratio = (event.clientX - rect.left - geometry.pad.l) / geometry.plotW;
        const index = Math.round(ratio * (geometry.longest - 1));
        hoverRef.current = { index: Math.max(0, Math.min(geometry.longest - 1, index)) };
        drawCombined(canvas, series, hoverRef.current, 1);
      }, [series]);

      const handleLeave = useCallback(() => {
        hoverRef.current = { index: -1 };
        drawCombined(chartRef.current, series, { index: -1 }, 1);
      }, [series]);

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
        transition: 'border-color 120ms ease, background-color 120ms ease',
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
        transition: 'opacity 120ms ease',
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
        transition: 'background-color 120ms ease',
      };

      const latestOf = (targetId) => items.find((item) => item.target === targetId);

      const rows = config.targets.map((target) => {
        const latest = latestOf(target.id);
        return h('div', {
          key: target.id,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 10px',
            borderRadius: 'var(--dsw-radius-md, 8px)',
            background: CARD_FILL,
            flexWrap: 'wrap',
          },
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
          h('span', { style: { color: TEXT_2, fontSize: 11, fontVariantNumeric: 'tabular-nums', minWidth: 190 } },
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
        ),
        modelOptions.length === 0 ? h('div', { style: { color: TEXT_2, fontSize: 11 } }, T.empty) : null,
        config.targets.length === 0
          ? h('div', { style: { color: TEXT_2, fontSize: 11 } }, T.noTargets)
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, rows),
        h('div', { style: { marginTop: 4 } },
          h('div', { style: { color: TEXT_2, fontSize: 11, marginBottom: 4 } }, T.chartTitle),
          h('canvas', {
            ref: chartRef,
            onMouseMove: handleMove,
            onMouseLeave: handleLeave,
            style: { width: '100%', height: 260, display: 'block', cursor: 'crosshair' },
          }),
          h('div', { style: { color: TEXT_2, fontSize: 11, marginTop: 4 } }, T.chartNote),
        ),
        h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', color: TEXT_2, fontSize: 11 } },
          config.targets.map((target) => h('span', { key: target.id, style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
            h('span', { style: { width: 8, height: 8, borderRadius: 4, background: colorOf(target.id) } }),
            series.find((item) => item.id === target.id)?.model || target.model)),
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
