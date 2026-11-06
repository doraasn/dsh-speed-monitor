# dsh-speed-monitor

DSH 插件「速度监控」：侧栏入口点开后，右侧面板用 **DSH 自己的模型清单** 测中转/官方接口的流式速度，默认每分钟一轮，可同时测多个模型。

```
侧栏                     主区域
┌─────────────┐   ┌───────────────────────────────────────────────┐
│ 新会话       │   │ 速度监控                          [ 立即采样 ]  │
│ 聊天         │   │ 采样间隔 [1 分钟] 测试模型 [+ 添加模型]        │
│ ⊙ 速度监控   │   │ ● astra-hub/deepseek-v4.1-flash  思考[low] ×  │
│ 更多         │   │ ● deepseek-official/deepseek-flash 思考[low] ×│
└─────────────┘   │ ┌ TTFB ┐ ┌ 总耗时 ┐ ┌ 吞吐 ┐                  │
                  └───────────────────────────────────────────────┘
```

## 采样方法

数值不是「点一次」得来的，方法参考 [term-llm benchmark](https://github.com/samsaffron/term-llm) 与 [llm-speed-test](https://github.com/bytehola/llm-speed-test)：

| 步骤 | 做法 | 原因 |
|---|---|---|
| 预热 | 每个模型每轮第一次请求丢弃 | 排除 DNS、TCP 建连、前缀缓存冷启动 |
| 采样 | 默认 3 次（1~5 可调） | 单次抖动大，3 次取中位数更稳 |
| 聚合 | 取中位数入库，同时记录 min / max | 中位数抗离群点，min/max 用来看波动 |
| 串行 | 多模型之间间隔 300ms，串行执行 | 并发会抢带宽，把数值拉高 |
| 失败 | 记录 `ok/runs` 与错误信息 | 区分「慢」与「挂了」 |

面板概览卡显示的就是中位数：首字节带 `±(max-min)/2` 波动，总耗时带区间；每条曲线上的一个点 = 一轮采样（3 个样本的中位数）。

## 功能

- **模型清单来自 DSH**：Client 读 `/api/settings/describe` 的 `llm-*` 命名空间，合并 `llm-pi-ai.providers` 与 `llm-deepseek.models`，不在插件里硬编码模型。
- **多模型并列**：每个模型一行，可增删；每行的模型、思考挡位各自独立保存。
- **默认每分钟一轮**（1/5/15/30/60 分钟可选），每轮每模型先预热 1 次再采样 3 次，取中位数。
- **默认目标**：`astra-hub / deepseek-v4.1-flash`（异常时回落到清单里第一个模型）。
- **单指标曲线**：顶部切换首字节 / 总耗时 / 吞吐，每个模型一条线（单调三次插值平滑 + 面积渐变），点图例可隐藏模型；悬浮显示该次采样的三项数值。**采样断档处曲线会断开**（相邻点间隔超过 3 倍中位间隔或 2 分钟），不是数据丢失，是刻意不跨缺口连线。时延用毫秒（越高越慢），吞吐用 tok/s（越高越快）。
- **模型显示名跟 DSH 一致**：用供应商 `displayName` + 模型 `name` 组合，例如 `DeepSeek · DeepSeek-V4.1-Flash`。
- **密钥不出主机**：按 `apiKeyEnv` 从 `~/.dsh/.credentials.yaml` 读取，Client 拿不到。

## 数据来源

| 项 | 说明 |
|---|---|
| 模型清单 | DSH 设置（`llm-pi-ai` / `llm-deepseek` 等命名空间） |
| 请求 | `POST {baseURL}/chat/completions`，`stream: true`、`stream_options.include_usage: true` |
| 存储 | `~/.dsh/storages/speed-monitor.json`（配置）、`speed-monitor.jsonl`（采样）、`speed-monitor.providers.json`（模型清单缓存） |
| 密钥 | 供应商配置里的 `apiKeyEnv`，指向 `~/.dsh/.credentials.yaml` 的字段 |

## 指标口径

| 字段 | 含义 |
|---|---|
| `ttfb_ms` | 请求发出 → 收到响应头 |
| `decode_ms` | 首个内容事件 → 最后一个内容事件 |
| `total_ms` | 请求发出 → 流结束 |
| `tokens` | `completion_tokens` |
| `tps_decode` | 解码吞吐 = tokens ÷ decode |
| `tps_e2e` | 端到端吞吐 = tokens ÷ total |

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/dsh-speed/api/state` | `{ config, providers, items, error }` |
| `POST` | `/dsh-speed/api/providers` | 写入模型清单 `{ providers }` |
| `POST` | `/dsh-speed/api/config` | 保存 `{ intervalMinutes, runs, targets }` |
| `POST` | `/dsh-speed/api/sample` | 立即采样，可带 `{ id }` 只采一个目标 |

## 安装

1. 侧栏 → **插件** → **添加插件**，粘贴仓库地址、`.tgz` 或本地目录
2. 启用后**重启 DSH**（Host 侧改动不热加载）
3. 侧栏出现「速度监控」入口，点开即见面板

## 常见问题

| 现象 | 处理 |
|---|---|
| 面板提示「还没有可用的模型清单」 | DSH 设置里没有配置任何 `llm-*` 供应商 |
| 某行一直 `--` | 该供应商 `apiKeyEnv` 在 `~/.dsh/.credentials.yaml` 里没有值，或 `baseURL` 为空 |
| 曲线不动 | 采样间隔被调大；或全部请求失败（行内会显示红色错误） |
| 想清零 | 删除 `~/.dsh/storages/speed-monitor.jsonl` |

## License

MIT
