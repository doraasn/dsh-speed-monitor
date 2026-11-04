/**
 * Client half of dsh-speed-monitor.
 *
 * 侧栏入口（sidebar.panellist）+ 右侧面板（main）：
 * 用 DSH 自己的模型清单测流式速度，默认每分钟一轮；一张图每个模型一条线，
 * 顶部切换首字节 / 总耗时 / 吞吐，图例在图上方。
 *
 * UI 用 dsh-plugin-dev 技能的 client-ui kit（Section / SettingsCard / SettingRow / Button），
 * 保证与 DSH 设置页同一套 token、字号与控件高度。
 */
window.__ModuleLoader__.load({
  id: 'dsh-speed-monitor',
  factory(require) {
    const React = require('react');
    const createPortal = require('react-dom').createPortal;

function createUi(react, createPortal) {
  const h = react.createElement
  const { useState, useEffect, useCallback, useRef } = react

  /* ---------- token 与字号 ---------- */
  const T = {
    text1: 'var(--dsw-alias-label-primary)',
    text2: 'var(--dsw-alias-label-secondary)',
    text3: 'var(--dsw-alias-label-tertiary, #8b929c)',
    line: 'var(--dsw-alias-border-l3)',
    cardFill: 'var(--dsw-alias-settings-card-fill, #2c2c2e)',
    cardStroke: 'var(--dsw-alias-settings-card-stroke, #ffffff26)',
    inputFill: 'var(--dsw-alias-bg-layer-1, #1b1b1c)',
    accent: 'var(--dsw-alias-button-primary-fill, #f9fafb)',
    accentText: 'var(--dsw-alias-label-primary-foreground, #0f1115)',
    radiusMd: 'var(--dsw-radius-md, 12px)',
    radiusXl: 'var(--dsw-radius-xl, 20px)',
  }
  const CARD_BG = 'color-mix(in srgb, currentColor 6%, transparent)'
  const TYPE = {
    h1: { fontSize: 18, fontWeight: 600, lineHeight: '26px', color: T.text1 },
    h2: { fontSize: 15, fontWeight: 600, lineHeight: '20px', color: T.text1 },
    body: { fontSize: 13, lineHeight: '20px', color: T.text1 },
    secondary: { fontSize: 13, lineHeight: '20px', color: T.text2 },
    small: { fontSize: 12, lineHeight: '18px', color: T.text2 },
    micro: { fontSize: 10, lineHeight: '13px', color: T.text2 },
    num: { fontSize: 15, fontWeight: 600, lineHeight: '20px', color: T.text1, fontVariantNumeric: 'tabular-nums' },
    ellipsis: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  }

  /* ---------- 纯函数 ---------- */
  const clamp = (value, min, max) => Math.max(min, Math.min(value, max))

  /** 浮层定位：优先右侧，放不下翻左；上下夹在视口内。pure，便于脱离 DOM 测试。 */
  function placeNear(rect, options = {}) {
    const width = options.width ?? 248
    const height = options.height ?? 120
    const gap = options.gap ?? 8
    const vw = options.viewport?.width ?? (typeof window === 'undefined' ? 1280 : window.innerWidth)
    const vh = options.viewport?.height ?? (typeof window === 'undefined' ? 800 : window.innerHeight)
    let side = 'right'
    let left = rect.right + gap
    if (left + width > vw - gap) {
      side = 'left'
      left = rect.left - gap - width
    }
    return {
      side,
      left: clamp(left, gap, Math.max(gap, vw - width - gap)),
      top: clamp(rect.top, gap, Math.max(gap, vh - height - gap)),
    }
  }

  const formatBytes = (bytes) => {
    const n = Number(bytes) || 0
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB'
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  }

  /* ---------- 本地状态：模块级 store + hook ---------- */
  /** 按设备持久化；只存差异值也安全（读取时与默认值合并）。 */
  function createStore(key, defaults = {}) {
    const read = () => {
      try {
        return { ...defaults, ...JSON.parse(localStorage.getItem(key) || '{}') }
      } catch {
        return { ...defaults }
      }
    }
    const store = {
      key,
      value: read(),
      listeners: new Set(),
      set(next) {
        store.value = typeof next === 'function' ? next(store.value) : next
        try { localStorage.setItem(key, JSON.stringify(store.value)) } catch {}
        for (const listener of store.listeners) listener(store.value)
      },
      patch(part) { store.set({ ...store.value, ...part }) },
      subscribe(listener) {
        store.listeners.add(listener)
        return () => { store.listeners.delete(listener) }
      },
    }
    return store
  }

  function useStore(store) {
    const [value, setValue] = useState(store.value)
    useEffect(() => store.subscribe(setValue), [store])
    return value
  }

  /** 轮询 + 失败保留上一帧（不要闪成空）。返回 [data, error, refresh]。 */
  function usePoll(task, intervalMs, deps = []) {
    const [state, setState] = useState({ data: null, error: false })
    const run = useCallback(async () => {
      try {
        const data = await task()
        setState({ data, error: false })
      } catch {
        setState((prev) => ({ data: prev.data, error: true }))
      }
    }, deps)
    useEffect(() => {
      run()
      const timer = setInterval(run, intervalMs)
      return () => clearInterval(timer)
    }, [run, intervalMs])
    return [state.data, state.error, run]
  }

  /* ---------- 侧栏卡片 ---------- */
  const StatusDot = ({ color, size = 6, offset = 1.5 }) => h('span', {
    style: {
      width: size,
      height: size,
      borderRadius: '50%',
      backgroundColor: color || T.text3,
      flex: '0 0 auto',
      alignSelf: 'center',
      transform: `translateY(${offset}px)`,
    },
  })

  /** 侧栏卡片：一行，圆点 + 名称 + 右侧数字。左右两组用同一 baseline。 */
  const Card = ({ children, style, ...rest }) => h('div', {
    ...rest,
    style: {
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: 6,
      padding: '2px 12px 5px',
      borderRadius: T.radiusMd,
      background: CARD_BG,
      minWidth: 0,
      overflow: 'hidden',
      ...style,
    },
  }, children)

  /** 侧栏卡片容器：竖排 + 3px 间距 + 左右 2px 内缩（与 newSession 对齐）。 */
  const CardStack = ({ children }) => h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 3, padding: '0 2px 2px', minWidth: 0 },
  }, children)

  const CardName = ({ children }) => h('span', { style: { ...TYPE.h2, fontSize: 12, flex: '1 1 auto', ...TYPE.ellipsis } }, children)
  const CardValue = ({ children }) => h('span', {
    style: { display: 'flex', alignItems: 'baseline', gap: 4, flex: '0 0 auto', ...TYPE.num },
  }, children)

  /* ---------- 设置页 ---------- */
  const Section = ({ title, description, children }) => h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640, minWidth: 0 },
  },
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 } },
    h('span', { style: TYPE.h1 }, title),
    description ? h('span', { style: TYPE.secondary }, description) : null),
  children)

  /** 设置卡片：官方那种 20px 圆角、深色填充、细描边。 */
  const SettingsCard = ({ children, style }) => h('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      padding: '14px 16px',
      borderRadius: T.radiusXl,
      border: `.5px solid ${T.cardStroke}`,
      background: T.cardFill,
      minWidth: 0,
      ...style,
    },
  }, children)

  /** 左标签 + 右控件的一行。 */
  const SettingRow = ({ label, hint, children }) => h('div', {
    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minWidth: 0 },
  },
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
    h('span', { style: { fontSize: 13, lineHeight: '18px', color: T.text1 } }, label),
    hint ? h('span', { style: { fontSize: 11, lineHeight: '16px', color: T.text2 } }, hint) : null),
  children)

  /** 药丸开关：36×20，白色底 + 深色旋钮，与官方设置页一致。 */
  const Switch = ({ checked, onChange, title, disabled = false }) => h('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': checked,
    disabled,
    onClick: onChange,
    title,
    style: {
      boxSizing: 'border-box',
      position: 'relative',
      flex: '0 0 auto',
      width: 36,
      height: 20,
      padding: 2,
      border: 0,
      borderRadius: 999,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: checked ? 'flex-end' : 'flex-start',
      transition: 'background-color .12s ease',
      backgroundColor: checked ? T.accent : 'var(--dsw-alias-border-l3, #4a4a4d)',
    },
  }, h('span', {
    style: {
      display: 'block',
      width: 16,
      height: 16,
      borderRadius: '50%',
      backgroundColor: checked ? T.accentText : 'var(--dsw-alias-label-primary, #f9fafb)',
      transition: 'background-color .12s ease',
    },
  }))

  const Button = ({ children, onClick, variant = 'primary', disabled = false, type = 'button' }) => h('button', {
    type,
    onClick,
    disabled,
    style: {
      boxSizing: 'border-box',
      height: 36,
      padding: '0 16px',
      borderRadius: T.radiusMd,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.6 : 1,
      fontSize: 14,
      lineHeight: '22px',
      fontWeight: 500,
      ...(variant === 'primary'
        ? { border: 'none', background: T.accent, color: T.accentText }
        : { border: `.5px solid ${T.cardStroke}`, background: 'transparent', color: T.text1 }),
    },
  }, children)

  /** 文本输入：44px 高、12px 圆角，与官方设置字段一致。 */
  const TextField = ({ label, hint, value, onChange, placeholder, type = 'text' }) => h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
  },
  label ? h('span', { style: { fontSize: 12, lineHeight: '16px', color: T.text2 } }, label) : null,
  h('input', {
    type,
    value: value ?? '',
    placeholder,
    onChange: (event) => onChange?.(event.target.value),
    style: {
      width: '100%',
      boxSizing: 'border-box',
      height: 44,
      padding: '0 12px',
      borderRadius: T.radiusMd,
      border: `.5px solid ${T.cardStroke}`,
      background: T.inputFill,
      color: T.text1,
      fontSize: 13,
      outline: 'none',
    },
  }),
  hint ? h('span', { style: { fontSize: 10, lineHeight: '13px', color: T.text2 } }, hint) : null)

  /* ---------- 浮层 ---------- */
  /** 悬停详情卡：portal 到 body，先按估算高度定位，挂载后按实测高度夹取。 */
  function HoverCard({ rect, width = 248, estimated = 120, children }) {
    const ref = useRef(null)
    const [placement, setPlacement] = useState(() => placeNear(rect, { width, height: estimated }))
    useEffect(() => {
      const node = ref.current
      if (!node) return
      const measured = node.getBoundingClientRect().height || estimated
      setPlacement(placeNear(rect, { width, height: measured }))
    }, [rect, width, estimated])
    const node = h('div', {
      ref,
      style: {
        position: 'fixed',
        left: placement.left,
        top: placement.top,
        width,
        zIndex: 2147400000,
        background: T.cardFill,
        border: `.5px solid ${T.cardStroke}`,
        borderRadius: T.radiusXl,
        padding: '12px 14px',
        boxShadow: '0 12px 32px rgba(0, 0, 0, .45)',
        color: T.text1,
      },
    }, children)
    return createPortal && typeof document !== 'undefined' ? createPortal(node, document.body) : node
  }

  /** 详情卡里的一行：左标题、右值。 */
  const InfoRow = ({ label, value }) => h('div', {
    style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, minWidth: 0 },
  },
  h('span', { style: { fontSize: 12, lineHeight: '18px', color: T.text2 } }, label),
  h('span', { style: { fontSize: 12, lineHeight: '18px', color: T.text1, fontVariantNumeric: 'tabular-nums' } }, value))

  /* ---------- 通用控件 ---------- */

  /** 下拉：触发器与设置输入框同高；浮层在触发器内绝对定位（不 portal），宽度与触发器一致。 */
  function Select({ value, options = [], onChange, width = 220, placeholder = '' }) {
    const [open, setOpen] = useState(false)
    const [hover, setHover] = useState(-1)
    const ref = useRef(null)
    const current = options.find((option) => option.value === value)

    useEffect(() => {
      if (!open) return undefined
      const onDown = (event) => { if (ref.current && ref.current.contains(event.target)) return; setOpen(false) }
      const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
      return () => {
        document.removeEventListener('mousedown', onDown)
        document.removeEventListener('keydown', onKey)
      }
    }, [open])

    const trigger = {
      boxSizing: 'border-box',
      width: '100%',
      height: 36,
      padding: '0 8px 0 12px',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      borderRadius: T.radiusMd,
      border: `.5px solid ${T.cardStroke}`,
      background: T.inputFill,
      color: T.text1,
      fontSize: 13,
      lineHeight: '20px',
      cursor: 'pointer',
      textAlign: 'left',
    }

    return h('div', { ref, style: { position: 'relative', width, minWidth: 0 } },
      h('button', {
        type: 'button',
        onClick: () => { setHover(-1); setOpen((previous) => !previous) },
        style: trigger,
        'aria-haspopup': 'listbox',
        'aria-expanded': open,
      },
        h('span', { style: { ...TYPE.ellipsis, flex: 1, textAlign: 'left', color: current ? T.text1 : T.text2 } }, current ? current.label : placeholder),
        h('svg', {
          width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: T.text2,
          strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
          style: { flex: 'none', transition: 'transform .12s ease', transform: open ? 'rotate(180deg)' : 'none' },
        }, h('path', { d: 'M6 9l6 6 6-6' })),
      ),
      open ? h('div', {
        role: 'listbox',
        style: {
          boxSizing: 'border-box',
          position: 'absolute',
          left: 0,
          top: 'calc(100% + 6px)',
          width,
          maxHeight: 320,
          overflowY: 'auto',
          padding: 4,
          zIndex: 40,
          background: T.cardFill,
          border: `.5px solid ${T.cardStroke}`,
          borderRadius: T.radiusMd,
          boxShadow: '0 12px 32px rgba(0, 0, 0, .45)',
        },
      }, options.map((option, index) => h('div', {
        key: option.value,
        role: 'option',
        'aria-selected': option.value === value,
        onMouseEnter: () => setHover(index),
        onMouseLeave: () => setHover(-1),
        onClick: () => { onChange?.(option.value); setOpen(false) },
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          height: 32,
          padding: '0 10px',
          borderRadius: 8,
          fontSize: 13,
          lineHeight: '20px',
          color: T.text1,
          cursor: 'pointer',
          background: hover === index
            ? 'color-mix(in srgb, currentColor 8%, transparent)'
            : option.value === value ? 'color-mix(in srgb, currentColor 4%, transparent)' : 'transparent',
        },
      },
        h('span', { style: { ...TYPE.ellipsis } }, option.label),
        option.value === value ? h('svg', {
          width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: T.text1,
          strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        }, h('path', { d: 'M5 13l4 4L19 7' })) : null,
      ))) : null,
    )
  }

  /** 分段切换（2~4 项）：选中项白底黑字，未选中透明，整组与输入框同高。 */
  function Segmented({ value, options = [], onChange }) {
    return h('div', {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        height: 36,
        padding: 2,
        boxSizing: 'border-box',
        borderRadius: T.radiusMd,
        border: `.5px solid ${T.cardStroke}`,
        background: T.inputFill,
      },
    }, options.map((option) => {
      const active = option.value === value
      return h('button', {
        key: option.value,
        type: 'button',
        onClick: () => onChange?.(option.value),
        style: {
          height: 30,
          padding: '0 12px',
          border: 'none',
          borderRadius: 9,
          cursor: 'pointer',
          fontSize: 13,
          lineHeight: '20px',
          background: active ? T.accent : 'transparent',
          color: active ? T.accentText : T.text2,
          transition: 'background-color .12s ease, color .12s ease',
        },
      }, option.label)
    }))
  }

  /** 图标按钮：28×28，hover 有底色；用于行内删除、刷新等。 */
  const IconButton = ({ label, onClick, disabled = false, children }) => h('button', {
    type: 'button',
    title: label,
    'aria-label': label,
    onClick,
    disabled,
    style: {
      width: 28,
      height: 28,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: 0,
      borderRadius: 8,
      background: 'transparent',
      color: disabled ? T.text3 : T.text2,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.6 : 1,
    },
  }, children)

  /** 指标块：上标签、下数值，用于面板顶部摘要。 */
  const StatTile = ({ label, value, hint }) => h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 96 },
  },
  h('span', { style: TYPE.micro }, label),
  h('span', { style: { ...TYPE.num, fontSize: 17, lineHeight: '22px' } }, value),
  hint ? h('span', { style: TYPE.micro }, hint) : null)

  /** 空态：居中提示，不占空容器。 */
  const EmptyState = ({ title, hint }) => h('div', {
    style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '24px 12px', textAlign: 'center' },
  },
  h('span', { style: TYPE.body }, title),
  hint ? h('span', { style: TYPE.small }, hint) : null)

  return {
    h, T, TYPE, CARD_BG,
    clamp, placeNear, formatBytes,
    createStore, useStore, usePoll,
    Card, CardStack, CardName, CardValue, StatusDot,
    Section, SettingsCard, SettingRow, Switch, Button, TextField,
    Select, Segmented, IconButton, StatTile, EmptyState,
    HoverCard, InfoRow,
  }
}

    const ui = createUi(React, createPortal);


    const h = ui.h;
    const { Section, SettingsCard, SettingRow, Button, Select, Segmented, IconButton, StatTile, EmptyState, T, TYPE } = ui;

    const PANEL_ID = 'dsh-speed-monitor';
    const API = '/dsh-speed/api';
    const PALETTE = ['#43c982', '#5aa9ff', '#efb83f', '#c47bff', '#ff8f6b', '#4dd0c4'];
    const BAD = '#ff6262';

    /** 三个可切换的指标。 */
    const METRICS = [
      { key: 'ttfb', label: '首字节', field: 'ttfb_ms', unit: 'ms' },
      { key: 'total', label: '总耗时', field: 'total_ms', unit: 'ms' },
      { key: 'tps', label: '吞吐', field: 'tps_e2e', unit: 'tok/s' },
    ];

    /** 界面固定中文。 */
    const T_CN = {
      label: '速度监控',
      title: '速度监控',
      description: '每轮对选中的模型发一次流式请求，记录首字节、总耗时与吞吐。',
      sample: '立即采样',
      sampling: '采样中…',
      interval: '采样间隔',
      intervalHint: '默认每 1 分钟采样一轮',
      models: '测试模型',
      modelsHint: '清单来自 DSH 的模型配置',
      add: '添加模型',
      remove: '删除',
      effort: '思考',
      empty: 'DSH 里还没有配置模型',
      noTargets: '点「添加模型」开始测速',
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

    /** 双区折线：上区时延（实线首字节、细线总耗时），下区吞吐；每个模型三条线。 */
    function drawChart(canvas, series, hover, progress) {
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || 700;
      const height = canvas.clientHeight || 260;
      if (!width || !height) return;
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
        ctx.fillText(T_CN.noData, 12, 30);
        return;
      }

      const latRaw = Math.max(1, ...lat);
      const tpsRaw = Math.max(1, ...tps);
      const latStep = niceStep(latRaw, 4);
      const tpsStep = niceStep(tpsRaw, 2);
      const latMax = Math.max(latStep, Math.ceil((latRaw * 1.08) / latStep) * latStep);
      const tpsMax = Math.max(tpsStep, Math.ceil((tpsRaw * 1.15) / tpsStep) * tpsStep);

      ctx.font = '10px sans-serif';
      const latTicks = [];
      for (let value = 0; value <= latMax + 1e-9; value += latStep) latTicks.push(Math.round(value));
      const tpsTicks = [];
      for (let value = 0; value <= tpsMax + 1e-9; value += tpsStep) tpsTicks.push(Math.round(value));
      const textWidth = (list) => Math.max(...list.map((value) => ctx.measureText(String(value)).width));
      const leftWidth = textWidth(latTicks) + 16;
      const rightWidth = textWidth(tpsTicks) + 16;

      const pad = { l: leftWidth, r: rightWidth, t: 18, b: 22 };
      const gap = 18;
      const contentH = Math.max(80, height - pad.t - pad.b - gap);
      const latH = Math.round(contentH * 0.7);
      const tpsH = contentH - latH;
      const plotW = Math.max(40, width - pad.l - pad.r);
      const latTop = pad.t;
      const tpsTop = pad.t + latH + gap;
      const longest = Math.max(...series.map((item) => item.points.length), 1);
      const x = (index) => pad.l + (longest === 1 ? plotW / 2 : (index / (longest - 1)) * plotW);
      const yLat = (value) => latTop + latH - (value / latMax) * latH;
      const yTps = (value) => tpsTop + tpsH - (value / tpsMax) * tpsH;
      canvas.__geometry = { pad, plotW, plotH: latH + gap + tpsH, longest };

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

      ctx.strokeStyle = colors.border;
      ctx.beginPath();
      ctx.moveTo(pad.l + 0.5, latTop);
      ctx.lineTo(pad.l + 0.5, latTop + latH);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(width - pad.r + 0.5, tpsTop);
      ctx.lineTo(width - pad.r + 0.5, tpsTop + tpsH);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pad.l, tpsTop + tpsH + 0.5);
      ctx.lineTo(width - pad.r, tpsTop + tpsH + 0.5);
      ctx.stroke();

      ctx.fillStyle = colors.axisText;
      ctx.textAlign = 'right';
      ctx.fillText('ms', width - pad.r - 4, latTop - 6);
      ctx.fillText('tok/s', width - pad.r - 4, tpsTop - 6);

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

      for (const item of series) {
        const points = item.points.map((point, index) => ({ index, value: point.ttfb })).filter((point) => Number.isFinite(point.value));
        if (points.length < 2) continue;
        const gradient = ctx.createLinearGradient(0, latTop, 0, latTop + latH);
        gradient.addColorStop(0, `${item.color}2e`);
        gradient.addColorStop(1, `${item.color}00`);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        points.forEach((point, index) => (index ? ctx.lineTo(x(point.index), yLat(point.value)) : ctx.moveTo(x(point.index), yLat(point.value))));
        ctx.lineTo(x(points[points.length - 1].index), latTop + latH);
        ctx.lineTo(x(points[0].index), latTop + latH);
        ctx.closePath();
        ctx.fill();
      }

      const line = (item, pick, scale, widthPx, alpha, dash) => {
        const points = item.points.map((point, index) => ({ index, value: pick(point) })).filter((point) => Number.isFinite(point.value));
        if (!points.length) return;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = item.color;
        ctx.lineWidth = widthPx;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.setLineDash(dash || []);
        ctx.beginPath();
        points.forEach((point, index) => (index ? ctx.lineTo(x(point.index), scale(point.value)) : ctx.moveTo(x(point.index), scale(point.value))));
        ctx.stroke();
        ctx.restore();
      };

      for (const item of series) {
        line(item, (point) => point.total, yLat, 1, 0.4);
        line(item, (point) => point.ttfb, yLat, 1.9, 1);
        line(item, (point) => point.tps, yTps, 1.4, 0.85);
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
            ctx.arc(px, yLat(point.ttfb), 3.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
          lines.push({
            color: item.color,
            text: item.model,
            detail: `${point.ttfb ?? '--'} / ${point.total ?? '--'} ms · ${point.tps ?? '--'} tok/s`,
          });
        }

        if (lines.length) {
          ctx.font = '11px sans-serif';
          const timeLabel = new Date(first[hover.index].ts).toLocaleTimeString();
          const textWidth2 = Math.max(
            ctx.measureText(timeLabel).width,
            ...lines.map((line) => ctx.measureText(`${line.text}  ${line.detail}`).width),
          ) + 30;
          const boxW = Math.min(textWidth2, width - 24);
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
            ctx.fillText(`${line.text}  ${line.detail}`, boxX + 21, rowY);
          });
        }
      }
    }

    /** 面板：上方固定配置区，下方图表填满剩余高度。 */
    function SpeedPanel() {
      const [config, setConfig] = React.useState({ intervalMinutes: 1, runs: 1, targets: [] });
      const [providers, setProviders] = React.useState({});
      const [items, setItems] = React.useState([]);
      const [error, setError] = React.useState('');
      const [sampling, setSampling] = React.useState(false);
      const [ready, setReady] = React.useState(false);
      const chartRef = React.useRef(null);
      const hoverRef = React.useRef({ index: -1 });
      const frameRef = React.useRef(0);

      const pullState = React.useCallback(async () => {
        const response = await fetch(`${API}/state`, { cache: 'no-store' });
        const data = await response.json();
        setConfig(data.config || { intervalMinutes: 1, runs: 1, targets: [] });
        setProviders(data.providers || {});
        setItems(data.items || []);
        setError(data.error || '');
      }, []);

      React.useEffect(() => {
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

      const saveConfig = React.useCallback(async (next) => {
        setConfig(next);
        await fetch(`${API}/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ intervalMinutes: next.intervalMinutes, runs: next.runs, targets: next.targets }),
        });
      }, []);

      const sampleNow = React.useCallback(async () => {
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
            value: `${providerName}\u0000${model.id}`,
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
        const rows = items
          .filter((item) => item.target === target.id && item.model === target.model)
          .slice(0, 160)
          .reverse();
        return {
          id: target.id,
          model: modelName,
          color: colorOf(target.id),
          points: rows.map((item) => ({ ts: item.ts, ttfb: item.ttfb_ms, total: item.total_ms, tps: item.tps_e2e })),
        };
      });

      React.useEffect(() => {
        if (!ready) return undefined;
        const draw = () => drawChart(chartRef.current, series, hoverRef.current, 1);
        draw();
        const canvas = chartRef.current;
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
        if (observer && canvas) observer.observe(canvas);
        window.addEventListener('resize', draw);
        return () => {
          if (observer) observer.disconnect();
          window.removeEventListener('resize', draw);
          cancelAnimationFrame(frameRef.current);
        };
      }, [ready, items, config.targets, config.intervalMinutes]);

      const handleMove = React.useCallback((event) => {
        const canvas = chartRef.current;
        const geometry = canvas?.__geometry;
        if (!canvas || !geometry) return;
        const rect = canvas.getBoundingClientRect();
        const ratio = (event.clientX - rect.left - geometry.pad.l) / geometry.plotW;
        const index = Math.round(ratio * (geometry.longest - 1));
        hoverRef.current = { index: Math.max(0, Math.min(geometry.longest - 1, index)) };
        drawChart(canvas, series, hoverRef.current, 1);
      }, [series]);

      const handleLeave = React.useCallback(() => {
        hoverRef.current = { index: -1 };
        drawChart(chartRef.current, series, { index: -1 }, 1);
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

      const latestFor = (target) => items.find((item) => item.target === target.id && item.model === target.model);
      const effortOptions = [
        { value: 'default', label: `${T_CN.effort}: 默认` },
        { value: 'none', label: `${T_CN.effort}: off` },
        { value: 'low', label: `${T_CN.effort}: low` },
        { value: 'high', label: `${T_CN.effort}: high` },
        { value: 'max', label: `${T_CN.effort}: max` },
      ];

      const targetRow = (target, index) => h(SettingRow, {
        key: target.id,
        label: `模型 ${index + 1}`,
        hint: (() => {
          const latest = latestFor(target);
          return latest
            ? `首字节 ${latest.ttfb_ms ?? '--'} ms · 总耗时 ${latest.total_ms ?? '--'} ms · ${latest.tps_e2e ?? '--'} tok/s`
            : '还没有采样数据';
        })(),
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap', justifyContent: 'flex-end' } },
          h('span', { style: { width: 8, height: 8, borderRadius: '50%', background: colorOf(target.id), flex: 'none' } }),
          h(Select, {
            value: `${target.provider}\u0000${target.model}`,
            options: modelOptions,
            width: 300,
            onChange: (next) => {
              const [provider, model] = next.split('\u0000');
              patchTarget(target.id, { provider, model });
            },
          }),
          h(Select, {
            value: target.effort || 'low',
            options: effortOptions,
            width: 132,
            onChange: (next) => patchTarget(target.id, { effort: next }),
          }),
          h(Button, { variant: 'secondary', onClick: () => removeTarget(target.id) }, T_CN.remove),
        ));

      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minHeight: 0, padding: '18px 22px', overflow: 'hidden' },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', flex: 'none' } },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
            h('span', { style: TYPE.h1 }, T_CN.title),
            h('span', { style: TYPE.small }, T_CN.description),
          ),
          h('div', { style: { flex: 1 } }),
          h(Button, { onClick: sampleNow, disabled: sampling }, sampling ? T_CN.sampling : T_CN.sample),
        ),
        error ? h('span', { style: { ...TYPE.small, color: BAD, flex: 'none' } }, error) : null,
        h('div', { style: { flex: 'none' } },
          h(SettingsCard, { style: { gap: 10 } },
            h(SettingRow, { label: T_CN.interval, hint: T_CN.intervalHint },
              h(Select, {
                value: String(config.intervalMinutes),
                options: [1, 2, 5, 10, 30].map((minute) => ({ value: String(minute), label: `${minute} 分钟` })),
                width: 132,
                onChange: (next) => void saveConfig({ ...config, intervalMinutes: Number(next) }),
              }),
            ),
            config.targets.map(targetRow),
            h(SettingRow, { label: T_CN.models, hint: T_CN.modelsHint },
              h(Button, { variant: 'secondary', onClick: addTarget, disabled: !modelOptions.length }, `+ ${T_CN.add}`),
            ),
          ),
        ),
        modelOptions.length === 0 ? h('span', { style: { ...TYPE.small, flex: 'none' } }, T_CN.empty) : null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', flex: 'none' } },
          series.map((item) => h('span', { key: item.id, style: { display: 'inline-flex', alignItems: 'center', gap: 6, ...TYPE.small } },
            h('span', { style: { width: 8, height: 8, borderRadius: '50%', background: item.color } }),
            item.model)),
          h('span', { style: { ...TYPE.micro, color: T.text3 } }, '上区：实线首字节 / 细线总耗时（ms）· 下区：吞吐（tok/s）'),
        ),
        h('div', { style: { flex: '1 1 auto', minHeight: 120, minWidth: 0 } },
          h('canvas', {
            ref: chartRef,
            onMouseMove: handleMove,
            onMouseLeave: handleLeave,
            style: { width: '100%', height: '100%', display: 'block', cursor: 'crosshair' },
          }),
        ),
        h('span', { style: { ...TYPE.micro, flex: 'none' } }, T_CN.hoverHint),
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
        const disposers = [];
        disposers.push(ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 45, label: () => T_CN.label }, PanelIcon));
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
