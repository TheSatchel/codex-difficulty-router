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

`route --request /path/to/request.json [--offline]`。请求示例没有预置任何成功记录：

```json
{
  "schemaVersion": 1,
  "parent": { "model": "gpt-6-astra", "effort": "max" },
  "task": { "kind": "bounded-edit", "profile": "my-project-acceptance-v1" },
  "catalog": [{ "model": "gpt-6-luna", "efforts": ["medium"] }],
  "inheritSpeed": true,
  "priority": "normal",
  "evidence": []
}
```

`parent` 来自当前实际会话；`catalog` 来自实际可用模型工具目录；`inheritSpeed: true` 表示宿主已明确子代理速度继承主会话。其他速度语义暂不支持，不能凭空填 true。数据工具不自行发现这些信息，不验证调用方陈述真实性。

每条 evidence 包含 `id`、`taskId`、`kind`、`profile`、精确 `model`、`effort`、`speed`（normal/fast/ultrafast）、`observedAt`、`verified`、`evidenceRef`、`outcome`、`durationMs` 和 `cost: {amount, unit}`。请求在提供证据时还须提供 `parent.speed`。`unit` 仅接受 USD 或 credits，不能换算混用。`outcome` 为 pass、capability-failure 或 environment-failure。

记录由主对话核对真实执行日志和交付物后写入用户指定的任务文件；`evidenceRef` 指向验收产物，`taskId` 必须代表同一组输入及验收标准。同一模式、同一任务的重试归入一个记录，时间与费用包含所有重试和调度开销；不要删掉失败后只保留成功。禁止把模型自评、模拟演练或元数据测试记成真实任务通过。没有可靠计费数据时不填假价格，不使用这条记录做优化。工具校验结构和规则，不能认证人工填写的验收记录。

## 选择顺序

1. 主模式必须有有效精确 AA 实测分；候选必须在实际目录中、有实测分且评分/推理档不超过主模式。未评分父模式不因继承而获豁免。
2. 默认使用主模式同型号、同推理档的原生子代理，标为 `parent-baseline`，并说明任务适配尚未验证；不能称为成本优化成功。
3. 候选必须在相同 kind/profile/speed 下，有至少 3 个不同真实任务与主模式成对通过验收，且最近 30 天没有已核实的能力失败。默认 3 个只是一条保守准入规则，不构成统计泛化证明；阈值在 `data/routing-policy.json` 中公开。
4. 比较成对任务的总费用与总耗时。normal 只采用平均费用严格更低的候选；urgent 只采用平均耗时严格更短且平均费用不高于基线的候选。跨候选只在相同任务集合、同计费单位上比较；任务集合不同则保持主模式基线，避免不公平比较。
5. 同值用模型 ID 和推理档固定排序。缺证据、过期、计费单位混用或环境失败均不自动升级。能力失败暂停该候选的优化资格；当前任务重试是否有益由主对话判断，并继续遵守预算和主模式上限。

三个边界：无评分→blocked；有评分但无任务记录→parent-baseline；记录完整且费用/时间改善→evidence-route。返回的 observedImprovement 是历史成对记录的比较，不是未来费用/成功率保证。

输出不是执行授权：仍需核对用户操作范围和预算。新版本不运行自动压测，不自动试未评分模型，不改主模式、不启动服务、不采集其他聊天的任务记录。
