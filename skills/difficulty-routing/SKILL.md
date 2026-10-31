---
name: difficulty-routing
description: "Prompt-only guidance for Codex and Claude Code coding tasks: assess difficulty, priority, speed and price, then request a real model/effort change using existing host controls; prefer bounded ordinary threads."
---

本技能通过文字规则引导模型，Codex 优先，兼容 Claude Code。不要安装、恢复或依赖本插件旧版的桌面路由后台。

## 先判断任务，再主动使用现有切换能力

1. 从当前需求、项目证据、未知项和验证要求估计任务的能力下限及可能需要的上限。结合上下文理解“继续”“按刚才做”，不要把短追问当成新的简单任务，也不要仅凭仓库大小升档。
2. 只考虑宿主实际提供的模型、推理档和速度。使用 Artificial Analysis 的实测 Intelligence Index；对照精确型号与推理档。缺失、null、估算、过期或名称不明确的评分不能授权调用，不借用别的型号或 Max 的分数给 Ultra，不试调用未知模型。
3. 在满足能力下限的候选中比较成本与速度。较小、足够的模型优先；高难度与紧急程度分别判断。速度为 `normal / fast / ultrafast`，推理档 `ultra` 是另一维度。普通任务选低成本组合，紧急任务再衡量提速收益与额外费用，不默认使用强模型 ultrafast。
4. **需要切换且宿主有明确的原生切换工具时，主动调用它并回读确认，不要停留在给建议。** 主对话目标受用户明确指定的资源与预算上限约束；子任务另外受主对话实际模式约束。当前模式足够时保持当前模式，不凭空增加预算或替用户固定费用限额。
5. **没有原生切换接口时，明确说明“尚未切换”，简短指出需要选择的模式。** 仅靠 prompt 不能改变已经执行中的模型；不要因为自己写了“改用某模型”就声称已经切换。不要编造工具、把终端 `/model` 当作 App 控制接口、发送隐藏消息给自己或反复启动 Codex 进程来模拟切换。

## 独立任务使用普通 thread

用户已授权自动拆分，且宿主能设置并验证资源上限时，把可独立交付的任务拆成普通持久化 thread，明确输入、验收、依赖与写入范围，再将结果整合回主对话。紧密耦合的决策留在主对话；不能验证子任务速度或其他资源上限时不盲目派发。

每个子任务的 Intelligence Index、推理档和速度都不得高于主 thread 的实际模式；主模式未知时不假定 Ultra。共享 checkout 的写任务串行，子 thread 不递归拆分，不向无关已有对话发送消息。

只有主模式实际为 `ultra` 时，模型才可自行选择 subagent；始终可选，不为了用 subagent 升档，也不以 subagent 代替用户要求的普通 thread。subagent 同样不得超过主模式上限。Claude Code 缺少普通 thread 接口时保持主会话，不虚构 Codex 专属能力。

## 数据与执行边界

优先使用已有有效缓存；网络可用时读取公开榜单。缓存应覆盖所有公开厂商、模型、推理档、退役及未评分条目，实际选择再与宿主目录取交集。无法取得有效评分时说明证据不足，不猜分数。网页 API 价格、ChatGPT credits 和套餐额度不能混成同一计费单位，未知加速档价格或吞吐率保留未知。

可选数据工具为 [router-data.mjs](../../bin/router-data.mjs)，仅处理公开榜单与本地 JSON。它必须显式接收缓存目录，不在插件加载时运行；不要擅自重建用户已清理的全局数据目录。无需该工具时直接使用宿主现有的网页读取能力，不为读榜单安装服务。

**为路由切换而创建 LaunchAgent、daemon、后台服务、MCP server、用户级 hook，修改 `CODEX_*` 环境变量、全局配置、App 文件或 app-server 连接，均不属于本技能。不得执行这些操作或运行历史版本的安装器。** 保持用户原有 App 连接与运行方式；本技能只注入以上 prompt 约束，实际切换以宿主接口的确认结果为准。
