# Codex Difficulty Router

**v0.4.0：纯 prompt／Skill 方案。v0.3.0 的桌面接入方案已撤回。**

插件现在只给模型加载任务路由规则，要求它在需要时使用宿主已有的原生接口切换模型、推理档和速度。没有 hook、MCP server、LaunchAgent、常驻进程、桌面连接代理或系统安装器，也不修改 App 及 `CODEX_*` 环境变量。不要再运行历史版本中的桌面安装脚本。

**Prompt 可以要求模型切换，但不能凭文字保证 App 的实际模型已改变。** 模型必须调用宿主实际提供的切换能力并确认结果；接口不存在时必须如实说“尚未切换”，不能把建议当作已执行。这是当前版本明确的能力边界。

## 注入的规则

正文在 [skills/difficulty-routing/SKILL.md](skills/difficulty-routing/SKILL.md)。通过 Codex／Claude Code 的正常 Skill 加载机制注入；也可以把正文作为对话规则。无需运行本仓库的任何系统安装器。

- 估计当前任务的能力下限与上限，区分复杂程度和优先级。
- 只选择宿主实际支持、且有实测 Artificial Analysis Intelligence Index 的精确型号／推理档；未评分的不试调用。
- 比较足够的小模型与大模型的速度、价格；分别处理 `normal / fast / ultrafast`，不把它们与推理档 `ultra` 混同。
- 需要切换时要求模型主动调用原生切换接口并回读；没有接口就明确报告未切换。
- 用户已授权且资源上限可验证时，独立任务拆为普通持久化 thread；仅在实际 Ultra 下允许模型自愿选择 subagent。
- 子任务的智力评分、推理档、速度不超过主 thread；禁止以系统配置、代理后端或隐藏消息绕过限制。

Codex 是主要宿主。Claude Code 共用这些文字规则，不虚构其没有的线程、速度或切换能力。

## 可选的完整榜单缓存

数据工具与 Skill 加载分开，**不会自动执行**。它只读取公开 Artificial Analysis 数据和本地 JSON，不调用 LLM，不读取账号凭据，不启动 Codex，不连接或控制 App。

```sh
node bin/router-data.mjs cache --cache-dir /explicit/user/chosen/directory
node bin/router-data.mjs coverage --cache-dir /explicit/user/chosen/directory --catalog /path/to/host-catalog.json
```

`--cache-dir` 必须明确填写，没有默认全局目录。初次没有缓存又离线时返回不可用，不补造数据。有效缓存可离线使用，过期数据不能授权调用。联网刷新失败保留上次有效快照，不修改其观测时间。

默认保存完整公开榜单，包括所有厂商、推理档、退役模型、未评分记录及原始公开价格／速度／benchmark 字段；数量以当期网页为准。候选匹配再使用用户提供的实际宿主目录，采用完整型号与精确推理档匹配，不维护少量手写模型白名单。

宿主目录 JSON 为数组，每项包含 `host`、精确 `model`、可用 `efforts`，以及可选 `displayName`、`speeds`。工具不自行启动宿主来探测型号。

来源：[Artificial Analysis 榜单](https://artificialanalysis.ai/leaderboards/models)。公开网页缓存无需 API key；缓存只存在用户明确选择的目录，不随插件发布，也不重新创建已删除的历史数据目录。

## 开发验证

需要 Node.js 22+，没有第三方运行时依赖。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
```

验证覆盖 prompt 包装边界、无自动执行入口、完整榜单解析、无评分排除、精确型号匹配、缓存过期、联网失败与并发刷新。测试不启动 App／Codex、不修改系统环境、不进行付费模型推理。Node 22／24 CI 仅由待审 PR 或手动触发。
