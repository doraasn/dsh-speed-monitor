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

/** kit v4（2026-11-06，按官方设置页分区头 18/13 对齐） */
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
    /* 官方设置页分区头：标题 18/600，说明 13 弱色（宿主 PluginsSettingsSection.css） */
    h1: { fontSize: 18, fontWeight: 600, lineHeight: '26px', color: T.text1 },
    h2: { fontSize: 15, fontWeight: 600, lineHeight: '20px', color: T.text1 },
    body: { fontSize: 13, lineHeight: '20px', color: T.text1 },
    secondary: { fontSize: 13, lineHeight: '20px', color: T.text2 },
    intro: { fontSize: 13, lineHeight: '20px', color: T.text3 },
    small: { fontSize: 12, lineHeight: '18px', color: T.text2 },
    micro: { fontSize: 11, lineHeight: '14px', color: T.text2 },
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
  /* 官方分区结构：flex column gap 12，h2 标题 + p 说明（说明 13 弱色），下面才是内容 */
  const Section = ({ title, description, children }) => h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640, minWidth: 0 },
  },
  h('h2', { style: { margin: 0, ...TYPE.h1 } }, title),
  description ? h('p', { style: { margin: 0, ...TYPE.intro } }, description) : null,
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
    h('span', { style: { fontSize: 13, lineHeight: '20px', color: T.text1 } }, label),
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
      whiteSpace: 'nowrap',
      flex: 'none',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.6 : 1,
      fontSize: 13,
      lineHeight: '20px',
      fontWeight: 500,
      ...(variant === 'primary'
        ? { border: 'none', background: T.accent, color: T.accentText }
        : { border: `.5px solid ${T.cardStroke}`, background: 'transparent', color: T.text1 }),
    },
  }, children)

  /** 文本输入：44px 高、12px 圆角，与官方设置字段一致。 */
  /** 输入框：与 Select / Button 同高（36px），支持单位后缀、禁用、错误态、回车提交。 */
  const Input = ({
    value,
    onChange,
    placeholder = '',
    type = 'text',
    width = 220,
    unit,
    disabled = false,
    invalid = false,
    min,
    max,
    step,
    autoFocus = false,
    onEnter,
  }) => {
    const [focused, setFocused] = useState(false)
    const border = invalid ? 'var(--dsw-alias-state-error-primary, #ff6262)' : focused ? T.text3 : T.cardStroke
    return h('div', {
      style: {
        width,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: 36,
        boxSizing: 'border-box',
        padding: '0 10px',
        borderRadius: T.radiusMd,
        border: `.5px solid ${border}`,
        background: T.inputFill,
        opacity: disabled ? 0.6 : 1,
        transition: 'border-color .12s ease',
      },
    },
      h('input', {
        type,
        value: value ?? '',
        placeholder,
        disabled,
        min,
        max,
        step,
        autoFocus,
        onChange: (event) => onChange?.(event.target.value),
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
        onKeyDown: (event) => { if (event.key === 'Enter') onEnter?.(event.target.value) },
        style: {
          flex: 1,
          minWidth: 0,
          border: 0,
          outline: 'none',
          background: 'transparent',
          color: T.text1,
          fontSize: 13,
          lineHeight: '20px',
          padding: 0,
        },
      }),
      unit ? h('span', { style: { ...TYPE.micro, flex: 'none' } }, unit) : null,
    )
  }

  /** 带标签/说明的输入框（Input 的组合封装，保留旧 API）。 */
  const TextField = ({ label, hint, width = '100%', ...props }) => h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
  },
  label ? h('span', { style: { fontSize: 12, lineHeight: '16px', color: T.text2 } }, label) : null,
  h(Input, { width, ...props }),
  hint ? h('span', { style: TYPE.micro }, hint) : null)

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
  function Select({ value, options = [], onChange, width = 220, placeholder = '', disabled = false }) {
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
      cursor: disabled ? 'default' : 'pointer',
      textAlign: 'left',
      opacity: disabled ? 0.55 : 1,
    }

    return h('div', { ref, style: { position: 'relative', width, minWidth: 0 } },
      h('button', {
        type: 'button',
        disabled,
        onClick: () => { if (disabled) return; setHover(-1); setOpen((previous) => !previous) },
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
      open && !disabled ? h('div', {
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
  h('span', { style: { ...TYPE.num } }, value),
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
    Section, SettingsCard, SettingRow, Switch, Button, Input, TextField,
    Select, Segmented, IconButton, StatTile, EmptyState,
    HoverCard, InfoRow,
  }
}

    const ui = createUi(React, createPortal);


    const h = ui.h;
    const { Section, SettingsCard, SettingRow, Button, Select, Segmented, Switch, Input, createStore, useStore, T, TYPE } = ui;

    /** 界面偏好持久化：切换页面/重开面板后保持指标、时间范围、隐藏的模型。 */
    const UI_STORE = createStore('dsh-speed-monitor:ui', { metric: 'ttfb', range: 'all', hidden: {} });

    const PANEL_ID = 'dsh-speed-monitor';
    const API = '/dsh-speed/api';
    const PALETTE = ['#43c982', '#5aa9ff', '#efb83f', '#c47bff', '#ff8f6b', '#4dd0c4'];
    const BAD = 'var(--dsw-alias-state-error-primary, #ff6262)';

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
      hoverHint: '悬浮查看该次采样的三项数值；点图例可隐藏某个模型',
      prompt: '提示词',
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

    /**
     * 时间轴折线：单指标、每个模型一条线。
     * view 为 null 时自动铺满全部数据；否则是 [startTs, endTs] 的窗口。
     * hover 传 { time }（鼠标所在时刻），按时间就近取点显示。
     */
    function drawChart(canvas, series, unit, hover, view) {
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

      // 时间窗口
      let t0 = Infinity;
      let t1 = -Infinity;
      for (const item of series) {
        for (const point of item.points) {
          if (!Number.isFinite(point.ts) || !Number.isFinite(point.value)) continue;
          t0 = Math.min(t0, point.ts);
          t1 = Math.max(t1, point.ts);
        }
      }
      if (!Number.isFinite(t0) || !Number.isFinite(t1)) {
        ctx.fillStyle = colors.muted;
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(T_CN.noData, width / 2, height / 2);
        ctx.textAlign = 'left';
        return;
      }
      if (view) {
        t0 = Math.max(t0, view[0]);
        t1 = Math.min(t1, view[1]);
      }
      if (!(t1 > t0)) t1 = t0 + 60_000;

      const visible = [];
      let vmax = 0;
      for (const item of series) {
        if (item.hidden) continue;
        const points = item.points.filter((point) => Number.isFinite(point.value) && point.ts >= t0 && point.ts <= t1);
        visible.push({ item, points });
        for (const point of points) vmax = Math.max(vmax, point.value);
      }
      if (!visible.some((entry) => entry.points.length)) {
        ctx.fillStyle = colors.muted;
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(T_CN.noData, width / 2, height / 2);
        ctx.textAlign = 'left';
        return;
      }

      const step = niceStep(Math.max(vmax, 1), 4);
      const max = Math.max(step, Math.ceil((vmax * 1.12) / step) * step);
      ctx.font = '11px sans-serif';
      const ticks = [];
      for (let value = 0; value <= max + 1e-9; value += step) ticks.push(Math.round(value * 10) / 10);
      const formatTick = (value) => (max < 10 ? value.toFixed(1) : String(Math.round(value)));
      const leftWidth = Math.max(...ticks.map((value) => ctx.measureText(formatTick(value)).width)) + 14;

      const pad = { l: leftWidth, r: 14, t: 22, b: 26 };
      const plotW = Math.max(40, width - pad.l - pad.r);
      const plotH = Math.max(40, height - pad.t - pad.b);
      const x = (ts) => pad.l + ((ts - t0) / (t1 - t0)) * plotW;
      const y = (value) => pad.t + plotH - (value / max) * plotH;
      canvas.__geometry = { pad, plotW, plotH, t0, t1 };

      // 网格
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      ctx.textBaseline = 'middle';
      for (const value of ticks) {
        const lineY = Math.round(y(value)) + 0.5;
        ctx.strokeStyle = colors.grid;
        ctx.beginPath();
        ctx.moveTo(pad.l, lineY);
        ctx.lineTo(width - pad.r, lineY);
        ctx.stroke();
        ctx.fillStyle = colors.axisText;
        ctx.textAlign = 'right';
        ctx.fillText(formatTick(value), pad.l - 8, lineY);
      }
      ctx.setLineDash([]);
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = colors.axisText;
      ctx.textAlign = 'right';
      ctx.fillText(unit, width - pad.r, pad.t - 8);

      // 时间刻度：按宽度自适应 3~8 个；跨天或跨度大时带日期
      const span = t1 - t0;
      const crossesDay = new Date(t0).toDateString() !== new Date(t1).toDateString();
      const withDate = crossesDay || span > 6 * 3600_000;
      const formatTime = (ts) => {
        const date = new Date(ts);
        const hh = String(date.getHours()).padStart(2, '0');
        const mm = String(date.getMinutes()).padStart(2, '0');
        return withDate ? `${date.getMonth() + 1}/${date.getDate()} ${hh}:${mm}` : `${hh}:${mm}`;
      };
      const tickCount = Math.max(3, Math.min(8, Math.floor(plotW / 130)));
      const marks = [];
      for (let i = 0; i < tickCount; i += 1) marks.push(t0 + (span * i) / (tickCount - 1));
      ctx.textAlign = 'center';
      marks.forEach((ts, index) => {
        const isFirst = index === 0;
        const isLast = index === marks.length - 1;
        const px = Math.min(Math.max(x(ts), pad.l + 24), width - pad.r - 24);
        ctx.fillStyle = colors.axisText;
        ctx.textAlign = isFirst ? 'left' : isLast ? 'right' : 'center';
        ctx.fillText(formatTime(ts), isFirst ? pad.l : isLast ? width - pad.r : px, height - 8);
      });
      ctx.textAlign = 'left';

      ctx.save();
      ctx.beginPath();
      ctx.rect(pad.l - 1, pad.t - 1, plotW + 2, plotH + 2);
      ctx.clip();

      // 采样间隔的中位数用于判断断档：超过 3 倍或 2 分钟就断开，不跨缺口连线
      const gaps = [];
      for (const entry of visible) {
        for (let i = 1; i < entry.points.length; i += 1) {
          const delta = entry.points[i].ts - entry.points[i - 1].ts;
          if (delta > 0) gaps.push(delta);
        }
      }
      gaps.sort((a, b) => a - b);
      const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 60_000;
      const breakAt = Math.max(medianGap * 3, 120_000);

      const segmentsOf = (points) => {
        const out = [];
        let current = [];
        for (const point of points) {
          if (current.length && point.ts - current[current.length - 1].ts > breakAt) {
            out.push(current);
            current = [];
          }
          current.push(point);
        }
        if (current.length) out.push(current);
        return out;
      };

      for (const entry of visible) {
        const { item, points } = entry;
        if (!points.length) continue;
        for (const segment of segmentsOf(points)) {
        // 点数远多于像素宽度时按桶抽稀：每桶保留时间序的 min/max，尖峰不丢
        let sampled = segment;
        const buckets = Math.max(1, Math.floor(plotW));
        if (segment.length > buckets * 2) {
          const size = Math.ceil(segment.length / buckets);
          const out = [];
          for (let i = 0; i < segment.length; i += size) {
            const bucket = segment.slice(i, i + size);
            if (bucket.length <= 2) {
              out.push(...bucket);
              continue;
            }
            let min = bucket[0];
            let max = bucket[0];
            for (const point of bucket) {
              if (point.value < min.value) min = point;
              if (point.value > max.value) max = point;
            }
            if (min.ts <= max.ts) out.push(bucket[0], min, max, bucket[bucket.length - 1]);
            else out.push(bucket[0], max, min, bucket[bucket.length - 1]);
          }
          sampled = out;
        }
        const coords = sampled.map((point) => ({ x: x(point.ts), y: y(point.value) }));

        if (coords.length >= 2) {
          const gradient = ctx.createLinearGradient(0, pad.t, 0, pad.t + plotH);
          gradient.addColorStop(0, `${item.color}30`);
          gradient.addColorStop(1, `${item.color}00`);
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.moveTo(coords[0].x, pad.t + plotH);
          coords.forEach((point) => ctx.lineTo(point.x, point.y));
          ctx.lineTo(coords[coords.length - 1].x, pad.t + plotH);
          ctx.closePath();
          ctx.fill();
        }

        ctx.strokeStyle = item.color;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        if (coords.length >= 3) {
          const slopes = [];
          for (let i = 0; i < coords.length - 1; i += 1) {
            slopes.push((coords[i + 1].y - coords[i].y) / Math.max(1e-6, coords[i + 1].x - coords[i].x));
          }
          const tangents = coords.map((_, i) => (i === 0 ? slopes[0] : i === coords.length - 1 ? slopes[slopes.length - 1] : (slopes[i - 1] + slopes[i]) / 2));
          ctx.moveTo(coords[0].x, coords[0].y);
          for (let i = 0; i < coords.length - 1; i += 1) {
            const a = coords[i];
            const b = coords[i + 1];
            const dx = (b.x - a.x) / 3;
            ctx.bezierCurveTo(a.x + dx, a.y + tangents[i] * dx, b.x - dx, b.y - tangents[i + 1] * dx, b.x, b.y);
          }
        } else {
          coords.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
        }
        ctx.stroke();

        if (coords.length === 1) {
          ctx.fillStyle = item.color;
          ctx.beginPath();
          ctx.arc(coords[0].x, coords[0].y, 3.4, 0, Math.PI * 2);
          ctx.fill();
        }
        }
      }
      ctx.restore();

      // 悬浮：按时间找最近点
      if (hover && Number.isFinite(hover.time) && hover.time >= t0 && hover.time <= t1) {
        const px = x(hover.time);
        ctx.strokeStyle = colors.border;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.round(px) + 0.5, pad.t);
        ctx.lineTo(Math.round(px) + 0.5, pad.t + plotH);
        ctx.stroke();
        ctx.setLineDash([]);

        const rows = [];
        for (const entry of visible) {
          const { item, points } = entry;
          if (!points.length) continue;
          let nearest = points[0];
          for (const point of points) {
            if (Math.abs(point.ts - hover.time) < Math.abs(nearest.ts - hover.time)) nearest = point;
          }
          const dotY = y(nearest.value);
          ctx.fillStyle = colors.tipFill;
          ctx.strokeStyle = item.color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x(nearest.ts), dotY, 3.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          rows.push({ color: item.color, title: item.model, detail: nearest.detail });
        }

        if (rows.length) {
          ctx.font = '12px sans-serif';
          const hoverDate = new Date(hover.time);
          const timeLabel = `${hoverDate.getMonth() + 1}/${hoverDate.getDate()} `
            + `${String(hoverDate.getHours()).padStart(2, '0')}:${String(hoverDate.getMinutes()).padStart(2, '0')}:${String(hoverDate.getSeconds()).padStart(2, '0')}`;
          const boxW = Math.min(Math.max(ctx.measureText(timeLabel).width, ...rows.map((row) => ctx.measureText(`${row.title}  ${row.detail}`).width)) + 34, width - 24);
          const boxH = 26 + rows.length * 18;
          let boxX = px + 14;
          if (boxX + boxW > width - 8) boxX = px - boxW - 14;
          boxX = Math.max(8, boxX);
          let boxY = pad.t + 4;
          if (boxY + boxH > pad.t + plotH) boxY = Math.max(8, pad.t + plotH - boxH);

          ctx.fillStyle = colors.tipFill;
          ctx.strokeStyle = colors.tipStroke;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(boxX, boxY, boxW, boxH, 10);
          else ctx.rect(boxX, boxY, boxW, boxH);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = colors.tipMuted;
          ctx.textAlign = 'left';
          ctx.fillText(timeLabel, boxX + 12, boxY + 18);
          rows.forEach((row, index) => {
            const rowY = boxY + 18 + (index + 1) * 18;
            ctx.fillStyle = row.color;
            ctx.beginPath();
            ctx.arc(boxX + 15, rowY - 3, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = colors.tipText;
            ctx.fillText(`${row.title}  ${row.detail}`, boxX + 24, rowY);
          });
        }
      }
    }

    /** 指标定义：时延用毫秒（越高越慢），吞吐用 tok/s（越高越快）。 */
    const METRICS = [
      { key: 'ttfb', label: '首字节', unit: 'ms', pick: (point) => point.ttfb },
      { key: 'total', label: '总耗时', unit: 'ms', pick: (point) => point.total },
      { key: 'tps', label: '吞吐', unit: 'tok/s', pick: (point) => point.tps },
    ];

    /** 模型卡：收起时一行（名称 + 编辑 / 删除），点编辑展开表单，底部取消 / 保存。 */
    function ModelCard({ target, options, color, latest, visible, onToggleVisible, onToggleMonitor, onSave, onRemove, index, dragging, dragOver, onDragStart, onDragOver, onDrop, onDragEnd }) {
      const [editing, setEditing] = React.useState(false);
      const [draft, setDraft] = React.useState(target);
      const signature = JSON.stringify(target);
      React.useEffect(() => {
        setDraft(target);
      }, [signature]);
      const set = (patch) => setDraft({ ...draft, ...patch });
      const label = options.find((option) => option.value === `${target.provider}\u0000${target.model}`)?.label || target.model;

      const outer = {
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        borderRadius: 'var(--dsw-radius-xl, 20px)',
        background: 'var(--dsw-alias-settings-card-fill, #2c2c2e)',
        border: `.5px solid ${T.cardStroke}`,
        padding: '10px 14px',
      };
      const inner = {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        marginTop: 10,
        padding: '14px 16px',
        borderRadius: 14,
        background: 'color-mix(in srgb, currentColor 5%, transparent)',
      };

      const handleDown = React.useRef(false);
      const canDrag = { value: false };
      return h('div', {
        draggable: true,
        onDragStart: (event) => {
          if (!canDrag.value) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', String(index));
          onDragStart();
        },
        onDragOver: (event) => {
          event.preventDefault();
          onDragOver();
        },
        onDrop: (event) => {
          event.preventDefault();
          onDrop();
        },
        onDragEnd: () => {
          canDrag.value = false;
          onDragEnd();
        },
        style: { ...outer, opacity: dragging ? 0.45 : 1, outline: dragOver ? `1px solid ${T.text2}` : 'none' },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 } },
          // 拖拽把手：只在按住它时才允许拖动，避免误触
          h('span', {
            onMouseDown: () => { canDrag.value = true; },
            onMouseUp: () => { canDrag.value = false; },
            title: '拖动调整顺序',
            style: { flex: 'none', cursor: 'grab', color: T.text3, fontSize: 13, lineHeight: '18px', letterSpacing: '-1px', userSelect: 'none', paddingRight: 2 },
          }, '≡'),
          // 色点单独一列，与两行文字整体垂直居中
          h('span', { style: { width: 8, height: 8, borderRadius: '50%', background: color, flex: 'none' } }),
          // 左：名称 + 速度，两行
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 auto' } },
            h('span', { style: { ...TYPE.body, color: T.text1, ...TYPE.ellipsis } }, label),
            h('span', { style: { ...TYPE.micro, ...TYPE.ellipsis } },
              latest
                ? `首字节 ${latest.ttfb_ms ?? '--'}ms · 总耗时 ${latest.total_ms ?? '--'}ms · ${latest.tps_e2e ?? '--'} tok/s`
                : '等待采样'),
          ),
          // 右：开关与按钮同一行
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flex: 'none' } },
            h('span', { style: { ...TYPE.micro, flex: 'none' } }, '监控'),
            h(Switch, {
              checked: target.monitor !== false,
              onChange: onToggleMonitor,
              title: target.monitor !== false ? '点击暂停该模型的采样' : '点击恢复该模型的采样',
            }),
            h('span', { style: { ...TYPE.micro, flex: 'none' } }, '显示'),
            h(Switch, { checked: visible, onChange: onToggleVisible, title: visible ? '点击隐藏该模型的曲线' : '点击显示该模型的曲线' }),
            h(Button, { variant: 'secondary', onClick: () => setEditing(!editing) }, editing ? '收起' : '编辑'),
            h('button', {
              type: 'button',
              onClick: onRemove,
              style: { background: 'transparent', border: 0, color: BAD, cursor: 'pointer', fontSize: 13, lineHeight: '18px', padding: '0 2px', flex: 'none' },
            }, T_CN.remove),
          ),
        ),
        editing ? h('div', { style: inner },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h(Select, {
              value: `${draft.provider}\u0000${draft.model}`,
              options,
              width: 240,
              onChange: (next) => {
                const [provider, model] = next.split('\u0000');
                set({ provider, model });
              },
            }),
            h(Select, {
              value: draft.effort || 'low',
              options: [
                { value: 'default', label: '思考: 默认' },
                { value: 'none', label: '思考: off' },
                { value: 'low', label: '思考: low' },
                { value: 'high', label: '思考: high' },
                { value: 'max', label: '思考: max' },
              ],
              width: 116,
              onChange: (next) => set({ effort: next }),
            }),
            h(Select, {
              value: String(draft.intervalMinutes || 1),
              options: [1, 5, 15, 30, 60].map((minute) => ({ value: String(minute), label: `每 ${minute} 分钟` })),
              width: 124,
              onChange: (next) => set({ intervalMinutes: Number(next) }),
            }),
            h(Input, {
              type: 'number', min: 1, max: 5, width: 96, unit: '次/轮',
              value: String(draft.runs || 1),
              onChange: (next) => set({ runs: Math.max(1, Math.min(5, Number(next) || 1)) }),
            }),
            h('div', { style: { flex: '1 1 220px', minWidth: 180 } },
              h(Input, {
                width: '100%',
                value: draft.prompt || '',
                placeholder: '任务内容',
                onChange: (next) => set({ prompt: next }),
              }),
            ),
            h('div', { style: { display: 'flex', gap: 8, flex: 'none', marginLeft: 'auto' } },
              h(Button, { variant: 'secondary', onClick: () => { setDraft(target); setEditing(false); } }, '取消'),
              h(Button, { onClick: () => { onSave(draft); setEditing(false); } }, '保存'),
            ),
          ),
        ) : null,
      );
    }

    /** 时间范围预设。 */
    const RANGES = [
      { value: '30m', label: '30 分钟', ms: 30 * 60_000 },
      { value: '2h', label: '2 小时', ms: 2 * 3600_000 },
      { value: '6h', label: '6 小时', ms: 6 * 3600_000 },
      { value: '24h', label: '24 小时', ms: 24 * 3600_000 },
      { value: 'all', label: '全部', ms: 0 },
    ];

    /** 数据缩放条：拖两端改窗口、拖中间平移、点轨道跳转；拖拽按绝对位置映射，避免抖动。 */
    function ZoomBar({ bounds, view, onChange }) {
      const trackRef = React.useRef(null);
      const dragRef = React.useRef(null);
      const [hover, setHover] = React.useState(false);

      if (!bounds || bounds[1] <= bounds[0]) return null;
      const total = bounds[1] - bounds[0];
      const minSpan = Math.max(5 * 60_000, total * 0.02);
      const start = view ? Math.max(bounds[0], view[0]) : bounds[0];
      const end = view ? Math.min(bounds[1], view[1]) : bounds[1];
      const leftPct = ((start - bounds[0]) / total) * 100;
      const widthPct = Math.max(1, ((end - start) / total) * 100);

      const timeAt = (clientX) => {
        const rect = trackRef.current?.getBoundingClientRect();
        if (!rect || !rect.width) return bounds[0];
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        return bounds[0] + ratio * total;
      };
      const emit = (from, to) => {
        let span = Math.min(total, Math.max(minSpan, to - from));
        let nextStart = Math.min(Math.max(from, bounds[0]), bounds[1] - span);
        onChange([nextStart, nextStart + span]);
      };

      const onPointerDown = (event) => {
        event.preventDefault();
        const time = timeAt(event.clientX);
        const handleZone = Math.max(8, (widthPct / 100) * total * 0.02);
        const nearLeft = Math.abs(time - start) <= Math.max(handleZone, total * 0.006);
        const nearRight = Math.abs(time - end) <= Math.max(handleZone, total * 0.006);
        if (view && nearLeft) dragRef.current = { mode: 'left', moved: false, x: event.clientX };
        else if (view && nearRight) dragRef.current = { mode: 'right', moved: false, x: event.clientX };
        else if (view && time > start && time < end) dragRef.current = { mode: 'move', moved: false, x: event.clientX, grab: time - start };
        else dragRef.current = { mode: 'jump', moved: false, x: event.clientX, time };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      };

      const onPointerMove = (event) => {
        const drag = dragRef.current;
        if (!drag) return;
        if (!drag.moved && Math.abs(event.clientX - drag.x) < 3) return;
        drag.moved = true;
        const time = timeAt(event.clientX);
        if (drag.mode === 'left') emit(time, end);
        else if (drag.mode === 'right') emit(start, time);
        else if (drag.mode === 'move') emit(time - drag.grab, time - drag.grab + (end - start));
      };

      const onPointerUp = (event) => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (!drag) return;
        // 纯点击（没拖动）才跳转，避免误触
        if (drag.mode === 'jump' && !drag.moved) {
          const span = view ? end - start : total / 4;
          const center = timeAt(event.clientX);
          emit(center - span / 2, center + span / 2);
        }
      };

      const barHeight = 10;
      const handle = (left) => ({
        position: 'absolute',
        left: `calc(${left}% - 2px)`,
        top: -2,
        bottom: -2,
        width: 4,
        borderRadius: 2,
        background: T.text2,
      });

      return h('div', {
        ref: trackRef,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: () => { dragRef.current = null; },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        title: '拖动两端调整范围，拖中间平移，单击跳转',
        style: {
          position: 'relative',
          height: barHeight,
          marginTop: 8,
          marginLeft: 44,
          marginRight: 14,
          borderRadius: 999,
          background: 'color-mix(in srgb, currentColor 10%, transparent)',
          cursor: 'pointer',
          touchAction: 'none',
          userSelect: 'none',
        },
      },
        h('div', {
          style: {
            position: 'absolute',
            left: `${leftPct}%`,
            width: `${widthPct}%`,
            top: 0,
            bottom: 0,
            borderRadius: 999,
            background: hover ? 'color-mix(in srgb, currentColor 30%, transparent)' : 'color-mix(in srgb, currentColor 22%, transparent)',
            border: '1px solid color-mix(in srgb, currentColor 36%, transparent)',
          },
        }),
        h('div', { style: handle(leftPct) }),
        h('div', { style: handle(leftPct + widthPct) }),
      );
    }

    /** 面板。 */
    function SpeedPanel() {
      const [config, setConfig] = React.useState({ intervalMinutes: 1, runs: 3, targets: [] });
      const [providers, setProviders] = React.useState({});
      const [items, setItems] = React.useState([]);
      const [error, setError] = React.useState('');
      const [sampling, setSampling] = React.useState(false);
      const [ready, setReady] = React.useState(false);
      const uiState = useStore(UI_STORE);
      const metric = uiState.metric || 'ttfb';
      const hidden = uiState.hidden || {};
      const range = uiState.range || 'all';
      const setMetric = (next) => UI_STORE.patch({ metric: next });
      const setHidden = (next) => UI_STORE.patch({ hidden: next });
      const setRange = (next) => UI_STORE.patch({ range: next });
      const [view, setView] = React.useState(null);
      const chartRef = React.useRef(null);
      const hoverRef = React.useRef({ time: null });
      const dragRef = React.useRef(null);

      const pullState = React.useCallback(async () => {
        const response = await fetch(`${API}/state`, { cache: 'no-store' });
        const data = await response.json();
        setConfig(data.config || { intervalMinutes: 1, runs: 3, targets: [] });
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
          body: JSON.stringify({
            intervalMinutes: next.intervalMinutes,
            runs: next.runs,
            prompt: next.prompt,
            targets: next.targets,
          }),
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
      const metricDef = METRICS.find((item) => item.key === metric) || METRICS[0];

      // 失败样本不画：只取 ok > 0 的记录，且 target + model 双匹配
      const series = config.targets.map((target) => {
        const provider = providers[target.provider];
        const modelName = provider?.models?.find((model) => model.id === target.model)?.name || target.model;
        const rows = items
          .filter((item) => item.target === target.id && item.model === target.model && item.ok > 0)
          .reverse();
        return {
          id: target.id,
          model: modelName,
          color: colorOf(target.id),
          hidden: Boolean(hidden[target.id]),
          points: rows.map((item) => ({
            ts: typeof item.ts === 'number' ? item.ts : new Date(item.ts).getTime(),
            value: metricDef.pick({ ttfb: item.ttfb_ms, total: item.total_ms, tps: item.tps_e2e }),
            detail: `${item.ttfb_ms ?? '--'} / ${item.total_ms ?? '--'} ms · ${item.tps_e2e ?? '--'} tok/s`,
          })),
        };
      });

      const bounds = React.useMemo(() => {
        let min = Infinity;
        let max = -Infinity;
        for (const item of series) {
          for (const point of item.points) {
            if (!Number.isFinite(point.ts)) continue;
            min = Math.min(min, point.ts);
            max = Math.max(max, point.ts);
          }
        }
        return Number.isFinite(min) ? [min, max] : null;
      }, [items, config.targets]);

      const effectiveView = React.useMemo(() => {
        if (!bounds) return null;
        if (view) return view;
        const preset = RANGES.find((item) => item.value === range);
        if (!preset || !preset.ms) return null;
        const end = bounds[1];
        return [Math.max(bounds[0], end - preset.ms), end];
      }, [bounds, view, range]);

      const draw = React.useCallback(() => {
        drawChart(chartRef.current, series, metricDef.unit, hoverRef.current, effectiveView);
      }, [series, metricDef, effectiveView]);

      React.useEffect(() => {
        if (!ready) return undefined;
        draw();
        const canvas = chartRef.current;
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
        if (observer && canvas) observer.observe(canvas);
        window.addEventListener('resize', draw);
        return () => {
          if (observer) observer.disconnect();
          window.removeEventListener('resize', draw);
        };
      }, [ready, draw]);

      const timeAt = (clientX) => {
        const canvas = chartRef.current;
        const geometry = canvas?.__geometry;
        if (!canvas || !geometry) return null;
        const rect = canvas.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left - geometry.pad.l) / geometry.plotW));
        return geometry.t0 + ratio * (geometry.t1 - geometry.t0);
      };

      const handleMove = React.useCallback((event) => {
        const canvas = chartRef.current;
        const geometry = canvas?.__geometry;
        if (!canvas || !geometry) return;
        if (dragRef.current) {
          const delta = event.clientX - dragRef.current.x;
          const span = geometry.t1 - geometry.t0;
          const shift = -(delta / geometry.plotW) * span;
          setView([geometry.t0 + shift, geometry.t1 + shift]);
          return;
        }
        const time = timeAt(event.clientX);
        if (time === null) return;
        hoverRef.current = { time };
        drawChart(canvas, series, metricDef.unit, hoverRef.current, effectiveView);
      }, [series, metricDef, effectiveView]);

      const handleLeave = React.useCallback(() => {
        hoverRef.current = { time: null };
        dragRef.current = null;
        draw();
      }, [draw]);

      const handleDown = React.useCallback((event) => {
        const geometry = chartRef.current?.__geometry;
        if (!geometry) return;
        dragRef.current = { x: event.clientX, t0: geometry.t0, t1: geometry.t1 };
      }, []);

      const handleUp = React.useCallback(() => {
        dragRef.current = null;
      }, []);

      const handleWheel = React.useCallback((event) => {
        event.preventDefault();
        const canvas = chartRef.current;
        const geometry = canvas?.__geometry;
        if (!canvas || !geometry) return;
        const anchor = timeAt(event.clientX) ?? (geometry.t0 + geometry.t1) / 2;
        const span = geometry.t1 - geometry.t0;
        const factor = event.deltaY > 0 ? 1.1 : 1 / 1.1;
        const nextSpan = Math.min(Math.max(span * factor, 60_000), bounds ? bounds[1] - bounds[0] : span * 10);
        const ratio = (anchor - geometry.t0) / span;
        const t0 = anchor - ratio * nextSpan;
        setView([t0, t0 + nextSpan]);
      }, [bounds]);

      const handleDoubleClick = React.useCallback(() => {
        setView(null);
        setRange('all');
      }, []);

      const [dragIndex, setDragIndex] = React.useState(null);
    const [dropIndex, setDropIndex] = React.useState(null);

    /** 拖动排序：移动数组元素后整体保存，顺序即采样顺序。 */
    const moveTarget = (from, to) => {
      if (from === null || to === null || from === to) return;
      const list = config.targets.slice();
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
      void saveConfig({ ...config, targets: list });
    };

    const patchTarget = (id, patch) => {
        void saveConfig({
          ...config,
          targets: config.targets.map((item) => (item.id === id ? { ...item, ...patch } : item)),
        });
      };

      const addTarget = () => {
        const first = modelOptions[0];
        if (!first) return;
        void saveConfig({
          ...config,
          targets: [
            ...config.targets,
            {
              id: `t${Date.now().toString(36)}`,
              provider: first.provider,
              model: first.model,
              effort: 'low',
              intervalMinutes: config.intervalMinutes || 1,
              runs: config.runs || 3,
              prompt: config.prompt || '',
            },
          ],
        });
      };

      const removeTarget = (id) => {
        void saveConfig({ ...config, targets: config.targets.filter((item) => item.id !== id) });
      };

      const latestFor = (target) => items.find((item) => item.target === target.id && item.model === target.model && item.ok > 0);

      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 14, height: '100%', minHeight: 0, padding: '20px 24px', overflowY: 'auto' },
      },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 12, flex: 'none' } },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
            h('span', { style: TYPE.h1 }, T_CN.title),
            h('span', { style: TYPE.intro }, T_CN.description),
          ),
          h('div', { style: { flex: 1 } }),
          h('div', { style: { flex: 'none' } },
            h(Button, { onClick: sampleNow, disabled: sampling }, sampling ? T_CN.sampling : T_CN.sample)),
        ),
        error ? h('span', { style: { ...TYPE.small, color: BAD, flex: 'none' } }, error) : null,
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', alignItems: 'start', gap: 10, flex: 'none' } },
          config.targets.map((target, index) => h(ModelCard, {
            key: target.id,
            index,
            dragging: dragIndex === index,
            dragOver: dropIndex === index && dragIndex !== null && dragIndex !== index,
            onDragStart: () => setDragIndex(index),
            onDragOver: () => setDropIndex(index),
            onDrop: () => { moveTarget(dragIndex, index); setDragIndex(null); setDropIndex(null); },
            onDragEnd: () => { setDragIndex(null); setDropIndex(null); },
            target,
            options: modelOptions,
            color: colorOf(target.id),
            latest: latestFor(target),
            visible: !hidden[target.id],
            onToggleVisible: () => setHidden({ ...hidden, [target.id]: !hidden[target.id] }),
            onToggleMonitor: () => patchTarget(target.id, { monitor: target.monitor === false }),
            onSave: (next) => patchTarget(target.id, next),
            onRemove: () => removeTarget(target.id),
          })),
          h('button', {
            type: 'button',
            onClick: addTarget,
            disabled: !modelOptions.length,
            style: {
              gridColumn: config.targets.length % 2 === 1 ? 'auto' : '1 / -1',
              height: 44,
              borderRadius: 'var(--dsw-radius-xl, 20px)',
              border: `1px dashed ${T.cardStroke}`,
              background: 'transparent',
              color: modelOptions.length ? T.text1 : T.text3,
              fontSize: 13,
              cursor: modelOptions.length ? 'pointer' : 'default',
            },
          }, `+ ${T_CN.add}`),
          modelOptions.length === 0 ? h('span', { style: TYPE.micro }, T_CN.empty) : null,
        ),
        h('div', {
          style: {
            flex: '1 1 auto',
            minHeight: 320,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: '14px 16px 10px',
            borderRadius: 'var(--dsw-radius-xl, 20px)',
            background: 'var(--dsw-alias-settings-card-fill, #2c2c2e)',
            border: `.5px solid ${T.cardStroke}`,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flex: 'none' } },
            h(Segmented, {
              value: metric,
              options: METRICS.map((item) => ({ value: item.key, label: item.label })),
              onChange: (next) => setMetric(next),
            }),
            h('div', { style: { width: 1, height: 20, background: T.cardStroke } }),
            h(Segmented, {
              value: view ? '' : range,
              options: RANGES.map((item) => ({ value: item.value, label: item.label })),
              onChange: (next) => {
                setView(null);
                setRange(next);
              },
            }),
            h('div', { style: { flex: 1 } }),
          ),
          h('div', { style: { flex: '1 1 auto', minHeight: 120 } },
            h('canvas', {
              ref: chartRef,
              onMouseMove: handleMove,
              onMouseLeave: handleLeave,
              onMouseDown: handleDown,
              onMouseUp: handleUp,
              onWheel: handleWheel,
              onDoubleClick: handleDoubleClick,
              style: { width: '100%', height: '100%', display: 'block', cursor: 'crosshair' },
            }),
          ),
          h(ZoomBar, {
            bounds,
            view: effectiveView,
            onChange: (next) => setView(next),
          }),
        ),
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
