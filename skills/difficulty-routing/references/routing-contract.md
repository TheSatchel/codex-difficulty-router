# 可复现的选模契约

输入是当前宿主模式与目录、任务类别、任务验收配置标识及已经验收的执行记录；输出是可复现的选择及理由。工具只读数据，不执行模型或修改宿主。榜单只负责准入和上限，不把任务映射为“需要多少智力分”。

## 任务类别

| kind | 使用条件 | 验收重点 |
| --- | --- | --- |
| transform | 已提供完整输入的抽取、格式转换、摘要 | 完整性、忠实性、输出约束 |
| bounded-edit | 范围和验收已明确的局部修改 | 目标行为与相关回归 |
| investigate | 原因未知的排查、资料核实、跨文件追踪 | 证据链和可复现结论 |
| design | 方案取舍、架构、复杂推理或混合任务 | 约束覆盖与独立复核 |

主模型只做类别标注，不估计数字智力阈值。续做保留类别，实质范围变化才重标；不明确或多类混合时归 design。`profile` 是仓库／领域和验收方案的稳定版本标识；不同项目、验收条件或版本不能借用记录。分类仍需人工/模型判断，确定性仅适用于固定输入之后的选模。

## 输入

`context` 读取本轮实际模式；`route --request /path/to/request.json --current [--offline]` 自动填入 parent。请求示例没有预置任何成功记录：

```json
{
  "schemaVersion": 1,
  "task": { "kind": "bounded-edit", "profile": "my-project-acceptance-v1" },
  "catalog": [{ "model": "gpt-6-luna", "efforts": ["medium"] }],
  "inheritSpeed": true,
  "priority": "normal",
  "evidence": []
}
```

`--current` 从 CODEX_THREAD_ID 定位当前活动会话的 turn_context，自动读取实际 model 和 effort，覆盖请求中可能过期的 parent；省略 parent 时默认执行同样读取。也可不带 --current，明确提供已由宿主确认的 parent，用于其他宿主或离线分析。`catalog` 仍由实际工具目录提供；`inheritSpeed: true` 仅表示速度继承，绝不表示模型/推理档继承。实际速度未记录时不猜默认值，仍可按明确继承关系约束速度，但不能拿未知速度比较历史费用和耗时。

读取器仅在当前 CODEX_HOME/sessions 的日期目录中查找当前线程 ID 的文件名，不读取其他聊天正文、不读取 config.toml/auth.json，不写文件。必须确认文件内线程身份、活动回合与最新 turn_context 一致；重复文件、残缺记录、回合已结束或上下文尚未写入都会明确返回 unavailable。读取的是本轮运行模式，不代表 UI 为下一轮预选但尚未执行的模式。没有本地日志或线程 ID 的宿主不假装读取成功。

每条 evidence 包含 `id`、`taskId`、`kind`、`profile`、精确 `model`、`effort`、`speed`（normal/fast/ultrafast）、`observedAt`、`verified`、`evidenceRef`、`outcome`、`durationMs` 和 `cost: {amount, unit}`。请求在提供证据时还须提供 `parent.speed`。`unit` 仅接受 USD 或 credits，不能换算混用。`outcome` 为 pass、capability-failure 或 environment-failure。

记录由主对话核对真实执行日志和交付物后写入用户指定的任务文件；`evidenceRef` 指向验收产物，`taskId` 必须代表同一组输入及验收标准。同一模式、同一任务的重试归入一个记录，时间与费用包含所有重试和调度开销；不要删掉失败后只保留成功。禁止把模型自评、模拟演练或元数据测试记成真实任务通过。没有可靠计费数据时不填假价格，不使用这条记录做优化。工具校验结构和规则，不能认证人工填写的验收记录。

## 选择顺序

1. 主模式须有有效实测分或可追溯的同型号近似参考；候选须在实际目录中且参考分/推理档不超过主模式。精确档位缺分不再自动阻断。默认允许估计，allowEstimates: false 或 --strict 恢复严格实测模式。
2. 优先检查是否有符合下述条件的成对任务记录；若没有，执行初始任务分配规则，绝不默认继承主模型/推理档。
3. 候选必须在相同 kind/profile/speed 下，有至少 3 个不同真实任务与主模式成对通过验收，且最近 30 天没有已核实的能力失败。默认 3 个只是一条保守准入规则，不构成统计泛化证明；阈值在 `data/routing-policy.json` 中公开。
4. 比较成对任务的总费用与总耗时。normal 只采用平均费用严格更低的候选；urgent 只采用平均耗时严格更短且平均费用不高于基线的候选。跨候选只在相同任务集合、同计费单位上比较；任务集合不同则保持主模式基线，避免不公平比较。
5. 同值用模型 ID 和推理档固定排序。缺证据、过期或计费单位混用时使用初始任务规则；环境失败不构成升级信号。同类别/profile 下已验证的近期能力失败会排除相应模式，包括速度未知或不同的情况，不能以缺速度为由绕过失败记录。

三个边界：模式无法读取/完全无数值来源/无合规候选→blocked；无可比任务记录→task-policy-route；记录完整且费用/时间改善→evidence-route。所有成功结果均返回明确 model、effort、inherit: false，调用原生工具时须显式传递。返回的 observedImprovement 是历史记录比较，不是未来费用/成功率保证。

## 无历史记录时的初始分配

| 任务 | 目标推理档 | 型号档次 |
| --- | --- | --- |
| transform | low | economy |
| bounded-edit | medium | balanced |
| investigate | high | strong |
| design | max | strong |

目标推理档先截断到主档位上限。每个实际可用型号选择不超过目标的最高可用档位；从中保留最接近目标的共同档位，再按有效指数参考值排序：economy 选较低端，balanced 选中位（偶数取较低中位），strong 选较高端。没有符合目标/主上限的候选就明确 blocked，不增加隐式父模型候选。

这些是公开可调的启发式规则，modelTier 不等于已测得的价格/吞吐等级。输出标为 heuristic-not-validated、costOptimization: not-established，不声称已证明省钱。已有可比数据证明候选更贵，或 urgent 下更慢时，启发式不会把该模式选回来。任务变更才调整类别；不因一次环境故障自动升档。速度仍受宿主继承限制，用户预算由主对话另行核对。

输出不是执行授权：仍需核对用户操作范围和预算。新版本不运行自动压测，不试完全无参考的型号，不改主模式、不启动服务、不采集其他聊天的任务记录。

## 缺档位评分的推断

- 优先保留精确实测。缺分时只使用同一完整型号、同一指数版本的有效数值，不从相邻代际或相似名字借分。
- 存在上下实测档位时，按公开 effortOrder 的序位线性插值。这是启发式假设，档位间隔并非经过标定的算力或能力距离。
- 无上下档位时，优先使用未区分档位的模型级分数；否则暂用最近实测档位。超出范围不人为增加“Ultra 奖励分”。
- 没有实测参考、但该精确档位有公开估计时，可沿用其估计并保留来源标签；不再用估计去推下一层估计。锚点不唯一、过期或完全无数值时不推断。
- 返回 estimated、verified: false、usableForRouting: true、方法及 anchors，confidence 为 heuristic-not-calibrated。原始榜单文件不补写估计，不伪造目标档位的测评页或置信区间。
- 参考分上限是近似比较；输出 usesEstimatedRatings 和 ceilingBasis 提醒调用方。推理档、实际宿主可用性和速度继承仍独立检查。估计评分不替代具体任务的成对验收记录。
