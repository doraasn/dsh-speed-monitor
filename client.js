/**
 * Client half of dsh-speed-monitor.
 *
 * 注册一个侧栏入口（sidebar.panellist）和一个右侧面板（main）：
 * 点侧栏按钮后在主区域打开「速度监控」，显示 TTFB、总耗时、吞吐三张曲线。
 *
 * 数据来自 Host 暴露的 /dsh-speed/api/history。
 */
window.__ModuleLoader__.load({
  id: 'dsh-speed-monitor',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const PANEL_ID = 'dsh-speed-monitor';
    const ROUTE = '/dsh-speed/api';
    const TEXT_1 = 'var(--dsw-alias-label-primary)';
    const TEXT_2 = 'var(--dsw-alias-label-secondary)';
    const LINE = 'var(--dsw-alias-border-l2, #2a3038)';
    const OK = '#43c982';
    const BAD = '#ff6262';

    /** 文案。 */
    const TEXT = {
      zh: {
        label: '速度监控',
        title: '速度监控',
        sample: '立即采样',
        sampling: '采样中…',
        ttfb: '首字节',
        total: '总耗时',
        tps: '端到端',
        samples: '样本',
        failures: '失败',
        empty: '暂无数据，采集器每 5 分钟一轮，也可点「立即采样」',
        chartTtfb: '首字节 TTFB（ms）',
        chartTotal: '总耗时（ms）',
        chartTps: '端到端吞吐（tok/s）',
        recent: '最近采样',
        time: '时间',
        tokens: 'token',
      },
      en: {
        label: 'Speed monitor',
        title: 'Speed monitor',
        sample: 'Sample now',
        sampling: 'Sampling…',
        ttfb: 'TTFB',
        total: 'Total',
        tps: 'Throughput',
        samples: 'Samples',
        failures: 'Failures',
        empty: 'No data yet — samples run every 5 minutes, or click "Sample now"',
        chartTtfb: 'TTFB (ms)',
        chartTotal: 'Total time (ms)',
        chartTps: 'End-to-end throughput (tok/s)',
        recent: 'Recent samples',
        time: 'Time',
        tokens: 'tokens',
      },
    };
    const lang = (typeof document !== 'undefined' && /^zh/i.test(document.documentElement.lang || '')) ? 'zh' : 'en';
    const t = TEXT[lang];

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

    /** 折线图：带 Y 轴刻度与首尾时间标签。 */
    function drawChart(canvas, rows, pick, color, unit) {
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || 600;
      const height = canvas.clientHeight || 180;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (!rows.length) return;

      const pad = { l: 48, r: 12, t: 10, b: 22 };
      const plotW = width - pad.l - pad.r;
      const plotH = height - pad.t - pad.b;
      const points = rows.map((row, index) => ({ index, value: pick(row), ts: row.ts })).reverse();
      const valid = points.filter((point) => Number.isFinite(point.value));
      if (!valid.length) return;

      const values = valid.map((point) => point.value);
      let min = Math.min(...values);
      let max = Math.max(...values);
      if (min === max) {
        min = Math.max(0, min - 1);
        max += 1;
      }
      const margin = (max - min) * 0.15;
      min = Math.max(0, min - margin);
      max += margin;

      const x = (index) => pad.l + (points.length === 1 ? plotW / 2 : (index / (points.length - 1)) * plotW);
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

      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      valid.forEach((point, index) => (index ? ctx.lineTo(x(point.index), y(point.value)) : ctx.moveTo(x(point.index), y(point.value))));
      ctx.stroke();

      ctx.fillStyle = color;
      valid.forEach((point) => {
        ctx.beginPath();
        ctx.arc(x(point.index), y(point.value), 2, 0, Math.PI * 2);
        ctx.fill();
      });

      points
        .filter((point) => !Number.isFinite(point.value))
        .forEach((point) => {
          ctx.fillStyle = BAD;
          ctx.beginPath();
          ctx.arc(x(point.index), pad.t + plotH - 4, 3, 0, Math.PI * 2);
          ctx.fill();
        });

      ctx.fillStyle = TEXT_2;
      ctx.textAlign = 'center';
      const ticks = [0, Math.floor((points.length - 1) / 2), points.length - 1];
      ticks.forEach((index) => {
        const ts = points[index]?.ts;
        const label = ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        ctx.fillText(label, Math.min(Math.max(x(index), pad.l + 16), width - pad.r - 16), height - 5);
      });
      ctx.textAlign = 'left';
      if (unit) ctx.fillText(unit, pad.l + 4, pad.t + 9);
    }

    /** 右侧面板：统计卡 + 三张曲线 + 最近采样表。 */
    function SpeedPanel() {
      const [items, setItems] = useState([]);
      const [meta, setMeta] = useState({ error: '', model: '' });
      const [sampling, setSampling] = useState(false);
      const ttfbRef = useRef(null);
      const totalRef = useRef(null);
      const tpsRef = useRef(null);

      const load = useCallback(async () => {
        try {
          const response = await fetch(`${ROUTE}/history`, { cache: 'no-store' });
          const data = await response.json();
          setItems(data.items || []);
          setMeta({ error: data.error || '', model: data.model || '' });
        } catch (error) {
          setMeta((prev) => ({ ...prev, error: String(error?.message || error) }));
        }
      }, []);

      useEffect(() => {
        void load();
        const timer = setInterval(() => void load(), 60_000);
        return () => clearInterval(timer);
      }, [load]);

      const redraw = useCallback(() => {
        const recent = items.slice(0, 120);
        drawChart(ttfbRef.current, recent, (row) => row.ttfb_ms, OK, 'ms');
        drawChart(totalRef.current, recent, (row) => row.total_ms, '#5aa9ff', 'ms');
        drawChart(tpsRef.current, recent, (row) => row.tps_e2e, '#efb83f', 'tok/s');
      }, [items]);

      useEffect(() => {
        redraw();
        window.addEventListener('resize', redraw);
        return () => window.removeEventListener('resize', redraw);
      }, [redraw]);

      const sampleNow = useCallback(async () => {
        setSampling(true);
        try {
          await fetch(`${ROUTE}/sample`, { method: 'POST' });
          await load();
        } finally {
          setSampling(false);
        }
      }, [load]);

      const latest = items[0];
      const failures = items.filter((item) => item.error).length;

      const stat = (name, value) => h('div', {
        style: { minWidth: 128, padding: '10px 14px', borderRadius: 8, background: 'color-mix(in srgb, currentColor 6%, transparent)' },
      },
        h('div', { style: { color: TEXT_2, fontSize: 11, lineHeight: '14px' } }, name),
        h('div', { style: { color: TEXT_1, fontSize: 19, marginTop: 3, fontVariantNumeric: 'tabular-nums' } }, value),
      );

      const chartBox = (ref, label) => h('div', { style: { flex: '1 1 0', minWidth: 280, display: 'flex', flexDirection: 'column' } },
        h('div', { style: { color: TEXT_2, fontSize: 11, marginBottom: 4 } }, label),
        h('canvas', { ref, style: { width: '100%', height: 170, display: 'block' } }),
      );

      const rows = items.slice(0, 12).map((item) => h('tr', { key: item.ts },
        h('td', { style: { color: TEXT_2, padding: '3px 10px 3px 0', whiteSpace: 'nowrap' } },
          new Date(item.ts).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })),
        h('td', { style: { padding: '3px 10px', fontVariantNumeric: 'tabular-nums' } }, item.ttfb_ms ?? '--'),
        h('td', { style: { padding: '3px 10px', fontVariantNumeric: 'tabular-nums' } }, item.total_ms ?? '--'),
        h('td', { style: { padding: '3px 10px', fontVariantNumeric: 'tabular-nums' } }, item.tokens ?? '--'),
        h('td', { style: { padding: '3px 10px', fontVariantNumeric: 'tabular-nums' } }, item.tps_e2e ?? '--'),
        h('td', { style: { padding: '3px 0', color: item.error ? BAD : TEXT_2, fontSize: 11 } }, item.error ? '×' : ''),
      ));

      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          height: '100%',
          minHeight: 0,
          padding: '18px 22px',
          overflow: 'auto',
          background: 'var(--dsw-alias-bg-primary, transparent)',
          color: TEXT_1,
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, t.title),
          h('span', { style: { color: TEXT_2, fontSize: 11 } },
            latest
              ? `${latest.ts ? new Date(latest.ts).toLocaleString() : ''}${meta.model ? ` · ${meta.model}` : ''}`
              : t.empty),
          h('div', { style: { flex: 1 } }),
          h('button', {
            type: 'button',
            onClick: sampleNow,
            disabled: sampling,
            style: {
              cursor: sampling ? 'default' : 'pointer',
              padding: '5px 14px',
              borderRadius: 6,
              border: `1px solid ${LINE}`,
              background: 'transparent',
              color: TEXT_1,
              fontSize: 12,
            },
          }, sampling ? t.sampling : t.sample),
        ),
        meta.error ? h('div', { style: { color: BAD, fontSize: 11 } }, meta.error) : null,
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
          stat(t.ttfb, latest?.ttfb_ms != null ? `${latest.ttfb_ms} ms` : '--'),
          stat(t.total, latest?.total_ms != null ? `${latest.total_ms} ms` : '--'),
          stat(t.tps, latest?.tps_e2e != null ? `${latest.tps_e2e} tok/s` : '--'),
          stat(t.samples, String(items.length)),
          stat(t.failures, String(failures)),
        ),
        h('div', { style: { display: 'flex', gap: 18, flexWrap: 'wrap' } },
          chartBox(ttfbRef, t.chartTtfb),
          chartBox(totalRef, t.chartTotal),
          chartBox(tpsRef, t.chartTps),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { style: { color: TEXT_2, fontSize: 11 } }, t.recent),
          h('table', { style: { borderCollapse: 'collapse', fontSize: 12 } },
            h('tbody', null, rows),
          ),
        ),
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
        const disposers = [];
        disposers.push(ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 45,
          label: () => t.label,
        }, PanelIcon));
        disposers.push(ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, SpeedPanel));
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

    return { inject: ['slots'], apply };
  },
});
