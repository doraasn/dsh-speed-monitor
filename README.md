# dsh-speed-monitor

DSH 插件「速度监控」：每 5 分钟对 OpenAI 兼容中转跑一轮流式请求，侧栏卡片显示首字节与总耗时，设置页显示完整曲线。

```
侧栏底部
┌──────────────────────────────────┐
│ 首字节 1.21s  总耗时 3.42s   ╱╲╱  │
└──────────────────────────────────┘
```

## 功能

- **自动采样**：Host 每 5 分钟发 3 次流式请求，取中位数落盘；失败轮次也记录，曲线里标红点。
- **侧栏卡片**：最新 TTFB / 总耗时 + 最近 24 个点的走势线，折叠侧栏时仍可见。
- **设置页曲线**：TTFB、总耗时、端到端吞吐三张图，附「立即采样」按钮与样本/失败计数。
- **密钥不出主机**：只在 Host 进程内读取，Client 只拿指标，拿不到密钥。

## 数据来源

| 项 | 说明 |
|---|---|
| 请求 | `POST {baseUrl}/chat/completions`，`stream: true`、`stream_options.include_usage: true` |
| 默认目标 | AstraHub `deepseek-v4.1-flash`，`reasoning_effort: low` |
| 存储 | `~/.dsh/storages/speed-monitor.jsonl`，每行一条采样记录 |
| 密钥 | `~/.dsh/.credentials.yaml` 里的 `ASTRA_HUB_API_KEY`，只读不写 |

## 指标口径

| 字段 | 含义 |
|---|---|
| `ttfb_ms` | 请求发出 → 收到响应头 |
| `decode_ms` | 首个内容事件 → 最后一个内容事件 |
| `total_ms` | 请求发出 → 流结束 |
| `tokens` | `completion_tokens` |
| `tps_decode` | 解码吞吐 = tokens ÷ decode |
| `tps_e2e` | 端到端吞吐 = tokens ÷ total |

## 安装

1. 侧栏 → **插件** → **添加插件**
2. 粘贴本目录的绝对路径（例如 `C:\Projects\work\dsh-plugins\dsh-speed-monitor`），或 `.tgz` 压缩包路径
3. 启用该组合包；**Host 侧改动不热加载，需要重启 DSH**
4. 重启后约 15 秒，侧栏底部出现第一张卡片

## 配置

默认值写死在 `index.js` 的 `DEFAULTS`，需要改就在 `cordis.patch.yml` 里覆盖：

```yaml
- insert:
    - id: speed-monitor
      name: dsh-speed-monitor
      config:
        baseUrl: https://www.astrahub-ai.com/v1
        model: deepseek-v4.1-flash
        credential: ASTRA_HUB_API_KEY
        intervalMinutes: 5
        runs: 3
        maxTokens: 300
        effort: low
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `https://www.astrahub-ai.com/v1` | 任意 OpenAI 兼容端点 |
| `model` | `deepseek-v4.1-flash` | 模型 id |
| `credential` | `ASTRA_HUB_API_KEY` | 凭据文件里的字段名 |
| `intervalMinutes` | `5` | 采样间隔（分钟） |
| `runs` | `3` | 每轮请求次数，取中位数 |
| `maxTokens` | `300` | 单次输出上限 |
| `effort` | `low` | `reasoning_effort`；填 `none` 显式关闭思考，留空则不传 |

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/dsh-speed/api/history` | 返回 `{ items, error, model }`，最新在前，最多 500 条 |
| `POST` | `/dsh-speed/api/sample` | 立即采样一轮，返回 `{ record, error }` |

## 常见问题

| 现象 | 处理 |
|---|---|
| 卡片显示 `--` | 检查 `~/.dsh/.credentials.yaml` 是否有该字段；或端点不可达 |
| 曲线一直为空 | 刚装上时首轮延迟 15 秒；也可点设置页「立即采样」 |
| 装完侧栏没出现 | 组合包未启用，或 Host 改动未重启 |
| 数字长期不变 | `intervalMinutes` 被改大，或采样全部失败（看失败计数） |

## License

MIT
