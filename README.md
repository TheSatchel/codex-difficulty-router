# Codex Difficulty Router

为 Codex 设计的任务调度插件：先估计任务能力下限与主 chat 允许的上限，再把**模型、推理难度、速度、优先级和价格**一起比较。优先把独立任务拆成可见、可恢复的普通 thread。Claude Code 提供兼容入口，Codex 是主要执行宿主。

当前为 **v0.2.0 实验实现**：全量榜单缓存、运行时模型目录匹配、核心策略、Codex JSON-RPC 路由代理、独立 thread 调度、MCP 工具、共同 hook 和 Claude 启动器已经实现。尚未用真实付费模型做端到端验收，也未向官方插件目录提交。演示分数和价格全部为虚构数据，真实榜单只存用户本机缓存。

## 选择规则

| 维度 | 行为 |
| --- | --- |
| 能力下限 | 根据任务语义、已知约束、未知项和当前项目元数据估计；不把仓库大小直接当成难度。 |
| 模型智力 | 使用 [Artificial Analysis Intelligence Index](https://artificialanalysis.ai/)；精确匹配宿主模型 ID、推理档和榜单条目。没有分数、分数为 null、映射不明确、数据过期时不调用。 |
| 速度 | `normal / fast / ultrafast`，与推理档 `low … ultra` 分开。只选宿主目录声明支持的速度。 |
| 优先级 | `background / normal / high / urgent`。明确指定优先级时覆盖自动推断；高难度不自动等于高优先级。 |
| 价格 | 在能力足够的候选中选达到时延目标的低成本组合；目标不可达时，在预算内选预计更快的候选并报告目标未满足。 |
| 小模型 | 能完成任务的小模型优先参与低成本竞争。用观测速度比较，不把参数大小当成固定的速度保证。 |
| 强模型提速 | 即使是 `6.1 Sol + ultrafast` 这类通用组合，也要比较其独立价格和时延收益；不设“万金油默认值”。 |
| 拆分 | 可独立验证、依赖和写范围清楚时创建普通持久化 thread；合计预算与数量在创建前检查。 |
| subagent | 只有实际推理档为 `ultra` 才允许模型自行选择，始终可选；不为了使用 subagent 自动升档。 |
| 子任务上限 | Intelligence Index、推理档、速度均不得超过主 chat 的实际档位和配置上限。未知档位不推断成 Ultra。 |

“下限”与“上限”是可解释的调度估计和资源约束，不是对工程项目最终可解性的数学证明。能力下限不足以容纳当前任务时返回阻塞状态，不静默用较弱模型继续。

## 宿主能力与边界

| 能力 | Codex | Claude Code |
| --- | --- | --- |
| 难度 / 优先级 / 价格评估 | 已实现 | 共用策略 |
| 实际切换模型、推理档和速度 | JSONL app-server 代理在每个新 turn 前写入真实参数 | 启动 / 恢复时应用 `--model`、`--effort`、`fastMode` |
| 独立持久化 thread 自动执行与结果汇总 | 已实现，调用 `thread/start` 与 `turn/start` | 当前版本未实现独立会话 DAG 执行 |
| `ultrafast` | 以实际账号模型目录为准 | 没有已核实的映射，拒绝发送 |
| 插件 hook | 自动加入规则并检查可见的委派工具 | 同一套 hook |

**单独安装 hook 不会接管现有 Codex 桌面 chat 的传输，也不能改写正在执行的模型。** 完整的每轮自动路由需要由宿主集成下述代理。MCP 的 `router_route` 只返回建议，不声称改变了当前 UI。Claude 启动器也不会在一个已经运行的交互进程内自动切换每一轮；需要从启动器恢复会话。

依据：[Codex app-server](https://learn.chatgpt.com/docs/app-server)、[Codex hooks](https://learn.chatgpt.com/docs/hooks)、[Codex speed](https://learn.chatgpt.com/docs/agent-configuration/speed)、[Claude fast mode](https://code.claude.com/docs/en/fast-mode)。宿主目录与实际返回值优先于文档中的示例型号。

## 离线运行

需要 Node.js 22+；没有 npm 运行时依赖。

```sh
git clone https://github.com/TheSatchel/codex-difficulty-router.git
cd codex-difficulty-router
npm run check
npm test
npm run demo
node bin/router.mjs assess --prompt '紧急：修复一个拼写错误' --project /absolute/path/to/project
```

`demo` 仅使用带 `synthetic: true` 标记的虚构模型、分数、价格和时延，不启动后端。生产路由和执行适配器拒绝这种数据。测试中的 fake app-server 也不会调用任何模型。

## 配置真实模型与价格

1. 在仓库外或被忽略的 `.router/` 目录准备私有配置，参考 [配置结构](examples/routing.config.json)。模板故意没有模型绑定或价格；未填写时无法授权调用。
2. 设置 `CDR_CONFIG` 为该文件的绝对路径；未设置时默认在插件私有数据目录读取 `routing.json`。配置由用户控制，不从任务文本中读取上限或认证信息。未配置的初次安装进入评估/设置模式，不自动调用模型，也不会阻断其他正常聊天。
3. **默认缓存完整榜单，不需要 API key。** 运行 `node bin/router.mjs cache`，程序从公开榜单读取页面的数据描述，再按网页“All”筛选自己的加载方式获取完整数据包；包括所有厂商、推理档、退役型号、未评分条目和全部公开指标。不逐个抓详情页，不受页面默认“Current”过滤影响。也可选择 [Data API](https://artificialanalysis.ai/data-api/docs)：设置 `AA_API_KEY` 后运行 `ratings-refresh --output /absolute/path/to/ratings.local.json`。两种方式只读元数据，不调用 LLM。
4. 运行 `node bin/router.mjs models` 读取实际 Codex 目录。macOS 检测到桌面应用时优先使用应用自带的 Codex 可执行文件，避免 PATH 中旧 CLI 的目录不全；默认通过其 `app-server proxy` 连接 daemon。可用 `CDR_CODEX_COMMAND` 显式指定目标宿主命令。独立 `app-server` 适合元数据核对或单独客户端集成，不是桌面 UI 接管开关。
5. **实际使用的候选来自 Codex 当前 `model/list`，不会把榜单条目当成可用模型列表。** 缓存与真实目录按完整型号名称/ID和精确推理档自动取交集，未来新增型号不需要修改白名单。`bindings: []` 允许自动匹配；自定义命名时可显式填写绑定。无评分、估算评分、名称不唯一、特殊 fallback 配置或未测量的档位不自动调用，也不借用其他档的分数。
6. 为每个允许的模型 / 推理档 / 速度组合填写一条 `metrics`。记录当前价格、实测速率、证据链接与时间。USD 和 credits 不混算。时延估计含预期推理 token，实际工具耗时与排队可能使结果不同。估算预算不是账单硬限额。

绑定字段：

```json
{
  "host": "codex",
  "model": "exact-model-id-from-host",
  "effort": "high",
  "aaSlug": "exact-measured-variant-slug",
  "evidenceUrl": "https://artificialanalysis.ai/models/exact-measured-variant-slug"
}
```

`metrics` 每条包含 `host`、`model`、`effort`、`speed`、`unit`、`inputPerMillion`、`outputPerMillion`、`ttftSeconds`、`outputTokensPerSecond`、`sourceUrl` 和 ISO 格式 `fetchedAt`。具体数字由实际计费和观测填写，不能把演示数字用于真实模型。

配置中的 `economics.tokenEstimate` 为输入、输出和推理 token 的规划估计；单次请求可以通过 `metadata.tokens` 覆盖。预算、时延目标和价格只在一致的计费单位下比较。缓存优惠、免费额度及不同订阅的乘数不会被自动臆测。

## Codex 使用

向 Codex 添加 marketplace：

```sh
codex plugin marketplace add TheSatchel/codex-difficulty-router
```

在支持的桌面客户端中选择 Satchel Routing 并安装。按宿主提示审阅并信任插件 hook。不要使用绕过 trust 的启动参数。该动作不会被仓库代码自动执行。[插件打包与手动安装说明](https://developers.openai.com/plugins/build/plugins)说明了 marketplace 与官方公共目录的区别。

对接 MCP 时可以显式使用 argv `node /absolute/path/to/codex-difficulty-router/bin/router.mjs mcp` 并传入 `CDR_CONFIG`。这适用于插件变量展开方式不同的宿主。

插件暴露四个工具：

| 工具 | 作用 |
| --- | --- |
| `router_cache` | 缓存完整榜单与公开价格/速度/benchmark字段，返回覆盖统计；不需要 API key，也不调用模型。 |
| `router_assess` | 自动分析当前任务与当前项目的文件名元数据，不调用模型。 |
| `router_route` | 查询可用目录，返回模型 / effort / speed / 价格选择和原因；不调用模型。 |
| `router_dispatch` | 校验任务 DAG 与主 chat 的实际模式；创建普通 thread，等待结果并交回主 chat。 |

`router_dispatch` 输入见 [拆分示例](examples/dispatch.json)。主 chat 的模型负责判断是否真正可拆分，并整理输入、输出、验收条件和依赖；代码负责边界与调度。相同 `requestId` 和输入会复用已有收据，避免不确定结果产生重复调用。失败或需要人工处理时保存已创建的 thread ID，并停止后续依赖任务。不会自动发消息给其他既有 chat。

### 内置缓存与联网刷新

安装后的设置模式会尝试预热**完整公开榜单**。`ratingsMode: "leaderboard"` 使用全量数据源，每次读取路由策略检查刷新期限；默认每 5 分钟尝试联网更新，页面和数据包请求分别最多等待 15 秒。网络失败或数据格式变化时保留上次有效快照；超过 `maxRatingAgeHours`（默认 168 小时）的缓存不能授权模型调用。`N/A` 保持未知，网页的 `Max` 评分不能借给 `Ultra`。显式配置 `ratingSources` 或 CLI `--url` 时才使用定向详情页导入。

缓存按来源集合隔离，放在插件私有数据目录的 `ratings-cache/`，使用原子替换，并记录最近刷新结果。初次没有缓存又离线时报告不可用。配置 `refreshIntervalSeconds: 0` 可在每次策略读取时都尝试联网。`router_cache` 的 `force: true` 和 CLI `cache --force` 可立即重试。网页价格不能直接当作 Codex 订阅的 credits 价格，也不会把普通吞吐率套到 ultrafast。

缓存每条保留原始公开记录 `raw`：未在当前策略中使用的 benchmark、价格分项、吞吐分位数、首 token / 首答案时延、上下文窗口等也一并保存。`coverage` 显示全量、实测、估算、未评分、退役、厂商、价格和速度覆盖率。运行 `node bin/router.mjs coverage` 查询与实际 Codex 目录的交集；也可用 `--input` 提供由目标宿主导出的目录。读取目录不会试调用模型。

完整的 turn 级自动选模供 app-server 客户端接入：

```text
your Codex client -> node bin/router.mjs proxy -> codex app-server proxy
```

代理保留 JSON-RPC、流式通知、审批和用户输入请求；新 turn 前检查榜单、宿主目录、价格与上限，写入 `model`、`effort`、`serviceTier` 和 `serviceTierForTurn`，并处理 `collaborationMode` 的覆盖优先级。`normal` 明确发送 `default`，避免继承上轮的高速档。活动 turn 使用 `turn/steer`，不伪装成已切换模型。`review/start` 与 `thread/compact/start` 会因缺少可验证的 turn 级覆盖而被拒绝，应改用经过路由的普通 turn。

CLI 也提供建议和显式执行：

```sh
node bin/router.mjs route --input examples/task.json
node bin/router.mjs dispatch --input /absolute/path/to/your-dispatch.json
```

## Claude Code 使用

```text
/plugin marketplace add TheSatchel/codex-difficulty-router
/plugin install codex-difficulty-router@satchel-routing
```

也可以用 `claude --plugin-dir /absolute/path/to/codex-difficulty-router` 临时加载插件；单独加载仍需由路由启动器提供可核验的会话模式。

为 Claude 单独配置 `host: "claude-code"`、榜单精确绑定和 `catalogPath`。catalog 是由用户核实的可用型号 / effort / speed 列表，不会通过模型推理探测可用性。每项使用 `{ "host": "claude-code", "model": "精确型号", "efforts": ["high"], "speeds": { "normal": "default" } }` 的结构；只有确认 fast 权限和对应价格时才添加 `fast`。

```sh
node bin/router.mjs claude-launch --input /absolute/path/to/request.json
```

请求包含 `prompt` 和可选 `metadata`；加入先前由启动器创建的 `sessionId` 可恢复同一会话并重新选择档位。启动器不会打开 fallback model，不会静默映射 `ultrafast`，也不会把 Claude 的 `max` 解释成 Codex 的 `ultra`。

## 验证与数据

运行 `npm run check` 和 `npm test`。测试覆盖缺失/过期评分、精确档位匹配、模型可用性、子任务上限、速度和价格取舍、合计预算、普通 thread DAG、失败后停止依赖、幂等收据、实际 JSON-RPC 参数与 MCP stdio。CI 在非草稿 PR 和手动运行时执行 Node 22/24 检查。

hook 的工具约束适用于宿主向 hook 暴露的委派调用，宿主权限和 sandbox 仍由宿主管理。仅凭插件不能证明任意第三方工具内部的模型调用也被拦截。项目扫描限于当前 checkout 的 `git ls-files` 元数据；不打开外部仓库、历史快照、`.env` 或对话原文。

代码为 MIT。真实榜单数据来自 Artificial Analysis，适用其[使用与归属要求](https://artificialanalysis.ai/data-api/docs)；代码许可证不授予第三方数据再分发权。仓库不附带真实排行榜快照、账号配置或密钥。
