/**
 * Client half of dsh-speed-monitor.
 *
 * 注册两个位置：
 *   sidebar.footer.action  侧栏底部小卡片：最新 TTFB / 总耗时 + 走势线
 *   settings.section       设置页「速度监控」：三张曲线 + 立即采样
 *
 * 数据来自 Host 暴露的 /dsh-speed/api/history。
 */
window.__ModuleLoader__.load({
  id: 'dsh-speed-monitor',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    /** 文案：跟随界面语言。 */
    const TEXT = {
      zh: {
        title: '速度监控',
        ttfb: '首字节',
        total: '总耗时',
        tps: '端到端',
        empty: '暂无数据，约 15 秒后出现第一个点',
        failed: '不可用',
        sample: '立即采样',
        sampling: '采样中…',
        latest: '最近采样',
        samples: '样本',
        failures: '失败',
        chartTtfb: '首字节 TTFB（ms）',
        chartTotal: '总耗时（ms）',
        chartTps: '端到端吞吐（tok/s）',
        ms: 'ms',
      },
      en: {
        title: 'Speed monitor',
        ttfb: 'TTFB',
        total: 'Total',
        tps: 'Throughput',
        empty: 'No data yet — first point in ~15s',
        failed: 'Unavailable',
        sample: 'Sample now',
        sampling: 'Sampling…',
        latest: 'Last sample',
        samples: 'Samples',
        failures: 'Failures',
        chartTtfb: 'TTFB (ms)',
        chartTotal: 'Total time (ms)',
        chartTps: 'Throughput (tok/s)',
        ms: 'ms',
      },
    };
    const lang = (typeof document !== 'undefined' && /^zh/i.test(document.documentElement.lang || '')) ? 'zh' : 'en';
    const t = TEXT[lang];

    const TEXT_1 = 'var(--dsw-alias-label-primary)';
    const TEXT_2 = 'var(--dsw-alias-label-secondary)';
    const OK = '#43c982';
    const BAD = '#ff6262';

    const cardStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      padding: '4px 12px',
      borderRadius: 'var(--dsw-radius-md)',
      background: 'color-mix(in srgb, currentColor 6%, transparent)',
      minWidth: 0,
      cursor: 'default',
    };
    const labelStyle = { color: TEXT_2, fontSize: 11, lineHeight: '14px', whiteSpace: 'nowrap' };
    const numStyle = { color: TEXT_1, fontSize: 12, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };

    /** 拉取历史数据；autoRefresh 为真时定时刷新。 */
    function useHistory(autoRefresh) {
      const [state, setState] = useState({ items: [], error: '', loading: true });

      const load = useCallback(async () => {
        try {
          const response = await fetch('/dsh-speed/api/history', { cache: 'no-store' });
          const data = await response.json();
          setState({ items: data.items || [], error: data.error || '', loading: false });
        } catch (error) {
          setState((prev) => ({ ...prev, error: String(error?.message || error), loading: false }));
        }
      }, []);

      useEffect(() => {
        void load();
        if (!autoRefresh) return undefined;
        const timer = setInterval(() => void load(), 60_000);
        return () => clearInterval(timer);
      }, [autoRefresh, load]);

      return [state, load];
    }

    /** 把一组数值画成走势线；opts.height 为 CSS 像素高。 */
    function drawSparkline(canvas, values, color, height) {
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || 64;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const data = values.filter((value) => Number.isFinite(value));
      if (data.length < 2) return;
      const min = Math.min(...data);
      const max = Math.max(...data);
      const span = max - min || 1;
      const x = (index) => (index / (data.length - 1)) * (width - 2) + 1;
      const y = (value) => height - 2 - ((value - min) / span) * (height - 4);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      data.forEach((value, index) => (index ? ctx.lineTo(x(index), y(value)) : ctx.moveTo(x(index), y(value))));
      ctx.stroke();
    }

    /** 大图：带坐标刻度的折线。 */
    function drawChart(canvas, rows, pick, color, unit) {
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || 600;
      const height = canvas.clientHeight || 160;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (rows.length < 1) return;

      const pad = { l: 48, r: 10, t: 8, b: 20 };
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
      const padValue = (max - min) * 0.15;
      min = Math.max(0, min - padValue);
      max += padValue;

      const x = (index) => pad.l + (points.length === 1 ? plotW / 2 : (index / (points.length - 1)) * plotW);
      const y = (value) => pad.t + plotH - ((value - min) / (max - min)) * plotH;

      ctx.strokeStyle = 'var(--dsw-alias-border-l3, #2a3038)';
      ctx.fillStyle = 'var(--dsw-alias-label-secondary, #8b94a3)';
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

      ctx.fillStyle = 'var(--dsw-alias-label-secondary, #8b94a3)';
      ctx.textAlign = 'center';
      const ticks = [0, Math.floor((points.length - 1) / 2), points.length - 1];
      ticks.forEach((index) => {
        const ts = points[index]?.ts || '';
        const label = ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        ctx.fillText(label, Math.min(Math.max(x(index), pad.l + 16), width - pad.r - 16), height - 4);
      });
      ctx.textAlign = 'left';
      if (unit) ctx.fillText(unit, pad.l + 4, pad.t + 9);
    }

    /** 侧栏小卡片。 */
    function SpeedCard() {
      const [{ items, error, loading }] = useHistory(true);
      const canvasRef = useRef(null);
      const latest = items[0];

      useEffect(() => {
        const values = items
          .slice(0, 24)
          .map((item) => item.ttfb_ms)
          .reverse();
        drawSparkline(canvasRef.current, values, latest?.error ? BAD : OK, 16);
      }, [items, latest]);

      const ttfb = latest?.ttfb_ms != null ? `${(latest.ttfb_ms / 1000).toFixed(2)}s` : '--';
      const total = latest?.total_ms != null ? `${(latest.total_ms / 1000).toFixed(2)}s` : '--';

      return h('div', { style: cardStyle, title: error || (latest ? `${t.title}：${latest.ts}` : t.empty) },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 } },
          h('span', { style: labelStyle }, t.ttfb),
          h('span', { style: numStyle }, loading ? '…' : ttfb),
          h('span', { style: labelStyle }, t.total),
          h('span', { style: numStyle }, loading ? '…' : total),
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          latest?.error ? h('span', { style: { color: BAD, fontSize: 11 } }, t.failed) : null,
          h('canvas', { ref: canvasRef, style: { width: 56, height: 16, display: 'block' } }),
        ),
      );
    }

    /** 设置页「速度监控」整页。 */
    function SpeedSettings() {
      const [{ items, error, loading }, reload] = useHistory(false);
      const [sampling, setSampling] = useState(false);
      const ttfbRef = useRef(null);
      const totalRef = useRef(null);
      const tpsRef = useRef(null);

      useEffect(() => {
        drawChart(ttfbRef.current, items.slice(0, 120), (row) => row.ttfb_ms, OK, 'ms');
        drawChart(totalRef.current, items.slice(0, 120), (row) => row.total_ms, '#5aa9ff', 'ms');
        drawChart(tpsRef.current, items.slice(0, 120), (row) => row.tps_e2e, '#efb83f', 'tok/s');
      }, [items]);

      useEffect(() => {
        const onResize = () => {
          drawChart(ttfbRef.current, items.slice(0, 120), (row) => row.ttfb_ms, OK, 'ms');
          drawChart(totalRef.current, items.slice(0, 120), (row) => row.total_ms, '#5aa9ff', 'ms');
          drawChart(tpsRef.current, items.slice(0, 120), (row) => row.tps_e2e, '#efb83f', 'tok/s');
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, [items]);

      const sampleNow = useCallback(async () => {
        setSampling(true);
        try {
          await fetch('/dsh-speed/api/sample', { method: 'POST' });
          await reload();
        } finally {
          setSampling(false);
        }
      }, [reload]);

      const latest = items[0];
      const failures = items.filter((item) => item.error).length;
      const stat = (name, value) =>
        h('div', { style: { minWidth: 120 } },
          h('div', { style: labelStyle }, name),
          h('div', { style: { ...numStyle, fontSize: 18, marginTop: 2 } }, value),
        );
      const chart = (ref, label) =>
        h('div', { style: { marginTop: 12 } },
          h('div', { style: { ...labelStyle, marginBottom: 4 } }, label),
          h('canvas', { ref, style: { width: '100%', height: 150, display: 'block' } }),
        );

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 2px 16px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            onClick: sampleNow,
            disabled: sampling,
            style: {
              cursor: sampling ? 'default' : 'pointer',
              padding: '4px 12px',
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l2, #2a3038)',
              background: 'transparent',
              color: TEXT_1,
              fontSize: 12,
            },
          }, sampling ? t.sampling : t.sample),
          error ? h('span', { style: { color: BAD, fontSize: 11 } }, error) : null,
        ),
        h('div', { style: { display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 4 } },
          stat(t.ttfb, latest?.ttfb_ms != null ? `${latest.ttfb_ms} ${t.ms}` : '--'),
          stat(t.total, latest?.total_ms != null ? `${latest.total_ms} ${t.ms}` : '--'),
          stat(t.tps, latest?.tps_e2e != null ? `${latest.tps_e2e}` : '--'),
          stat(t.samples, String(items.length)),
          stat(t.failures, String(failures)),
        ),
        loading ? h('div', { style: labelStyle }, '…') : null,
        items.length === 0 ? h('div', { style: labelStyle }, t.empty) : null,
        chart(ttfbRef, t.chartTtfb),
        chart(totalRef, t.chartTotal),
        chart(tpsRef, t.chartTps),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register({ id: 'speed-monitor', name: 'sidebar.footer.action', order: 10 }, SpeedCard));
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ id: 'speed-monitor', name: 'settings.section', order: 60, label: () => t.title }, SpeedSettings));
      },
    };
  },
});
