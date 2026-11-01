# Codex Difficulty Router

**v0.6.0：内置完整公开榜单快照，并提供明确的评分查询入口，修正“没有读取数据就报告评分无法核实”的缺口。仍为 prompt／Skill 方案，执行使用原生 subagent。v0.3.0 的桌面接入方案已撤回。**

插件给模型加载子代理路由规则：主对话保持当前模型，负责需求、规划、分配、验收和汇总；实际执行优先交给宿主原生 subagent，并在创建时选择合适的模型和推理档。没有 hook、MCP server、LaunchAgent、常驻进程、桌面连接代理或系统安装器，也不修改 App 及 `CODEX_*` 环境变量。不要运行历史版本中的桌面安装脚本。

**这不会切换主聊天的模型。** 路由的实际动作是调用宿主已有的 subagent 工具；子代理的创建和任务完成须分别确认，不能把文字建议或 Skill 已启用当作已经派发成功。

## 注入的规则

正文在 [skills/difficulty-routing/SKILL.md](skills/difficulty-routing/SKILL.md)。单独安装插件仍使用正常 Skill 发现机制，不能把 `enabled: true` 当成正文已执行。

要默认进行路由检查，将 [prompts/codex-entry.md](prompts/codex-entry.md) 的标记块追加到 Codex 个人 `~/.codex/AGENTS.md`，保留已有指令，不覆盖整个文件。该入口要求新任务、续做及难题准备请求先读取当前可用列表中的 Skill，详细约束仍由插件维护，不硬编码安装版本。它不自动修改文件；卸载或禁用插件后，技能不在当前可用列表时入口不生效，也可删除两个 `difficulty-router:entry` 标记之间的整段。

Codex 在新运行开始时构建个人及项目指令链，已有会话不会因为文件更新就被证明已经重新加载；使用新会话验证。官方机制见 [AGENTS.md 说明](https://learn.chatgpt.com/docs/agent-configuration/agents-md)。也可从技能选择器显式选中路由技能，无需本仓库的系统安装器。

- 估计当前任务的能力下限与上限，区分复杂程度和优先级。
- 由当前主模型判断难度，不另外启动评估模型；首次检查或受阻时简短说明主模式、路由动作和原因。
- 只有“有个难题”等预告、没有实际题目时，说明已检查且等待题目，不空派子代理。
- 只选择宿主实际支持、且有实测 Artificial Analysis Intelligence Index 的精确型号／推理档；未评分的不试调用。
- 在满足任务能力下限的候选中比较模型速度与价格，计入委派、复核和重试开销。
- 优先使用原生 subagent 执行，不再自动创建普通持久化聊天，不再要求主对话必须为 Ultra。
- 子代理的智力评分、推理档和速度均不超过主对话实际模式，并服从用户预算；主模式或评分未知时不盲目派发。
- 当前 Codex 子代理速度随主会话继承，不能给每个子代理独立设置 `normal / fast / ultrafast`；不编造速度参数，不与推理档 `ultra` 混同。
- 主对话检查交付物并汇总，子代理不递归委派；极短问答、强耦合决策和关键阻塞允许主对话直接处理。
- 没有合规候选或原生工具不可用时说明限制，不能把未派发、未完成或验证失败报告成成功。

**保留能力上限意味着：便宜的小模型主对话不能把难题派给超出主模式的强模型。** 省钱主要靠把适合的执行交给较小子模型，不通过提高主模式或跳过评分绕过这条限制。

主模式本身没有精确实测评分时，入口会要求明确说明“主模式评分缺失，无法验证子代理上限，本轮未派发”。更新指令不能生成榜单没有的测量数据，也不会自动替换用户选定的主模型。

Codex 是主要宿主。Claude Code 共用规则并使用其已有 subagent 接口，不虚构其没有的参数。原生机制及默认继承行为见 [OpenAI Subagents 文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)。

## 完整榜单快照与评分查询

插件随附 [data/leaderboard.json](data/leaderboard.json)，保存抓取时的全部公开条目、实测分数、未评分状态及原始指标，不是少量手写模型表。数据工具不在插件加载时运行；Skill 在实际任务开始、主模式已确认后明确调用它，不能把未查数据误报成模型无分。

```sh
node bin/router-data.mjs assess --model gpt-6-astra --effort max
node bin/router-data.mjs assess --model gpt-6-astra --effort max --offline
node bin/router-data.mjs assess --model gpt-6-astra --effort max --catalog /path/to/actual-host-catalog.json
```

`assess` 先尝试公开网页，失败时使用有效内置快照；`--offline` 只查内置快照，不访问网络。查询不会写文件、创建缓存目录、读取账号凭据、调用 LLM、启动 Codex 或控制 App。可用目录必须来自实际宿主，工具不自行探测；批量变体使用同一个数据快照。

结果明确区分 `verified`、`unrated`、`not-in-leaderboard`、`ambiguous` 和数据不可用，包含来源、观测时间、指数版本与证据 URL。只有精确变体的有效实测分可以作为路由依据，不能借用 Max 分数给 Ultra。读取失败不等于榜单未评分。

需要把刷新结果另外保存到用户明确选择的目录时，使用原有命令：

```sh
node bin/router-data.mjs cache --cache-dir /explicit/user/chosen/directory
node bin/router-data.mjs coverage --cache-dir /explicit/user/chosen/directory --catalog /path/to/host-catalog.json
```

`cache`／`coverage` 的 `--cache-dir` 必须明确填写，没有默认全局目录。`assess` 无需这个参数，使用内置快照回退。有效快照可离线使用，默认有效期 168 小时；过期数据不能授权调用。联网失败不会把旧观测时间改成当前时间。

默认保存完整公开榜单，包括所有厂商、推理档、退役模型、未评分记录及原始公开价格／速度／benchmark 字段；数量以当期网页为准。候选匹配再使用用户提供的实际宿主目录，采用完整型号与精确推理档匹配，不维护少量手写模型白名单。

宿主目录 JSON 为数组，每项包含 `host`、精确 `model`、可用 `efforts`，以及可选 `displayName`、`speeds`。工具不自行启动宿主来探测型号。

来源：[Artificial Analysis 榜单](https://artificialanalysis.ai/leaderboards/models)。公开网页查询无需 API key；随插件发布的快照保留抓取时间和来源，不重新创建已删除的历史数据目录。发布新版时可以联网更新该文件，不能手填或估算缺失分数。

## 开发验证

需要 Node.js 22+，没有第三方运行时依赖。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
```

验证覆盖包装边界、无自动执行入口、完整榜单解析、无评分排除、精确型号匹配、缓存过期、联网失败与并发刷新。自动化检查不能证明模型一定选择或执行 Skill；实际委派须用宿主运行记录另行验证。测试不启动 App／Codex、不修改系统环境、不进行付费模型推理。Node 22／24 CI 仅由待审 PR 或手动触发。
