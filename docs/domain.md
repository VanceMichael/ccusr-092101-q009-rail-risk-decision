# 领域约定

购票账号、乘车人关系、支付主体、设备证明和处置决定使用脱敏引用。

外部主体一律使用不含真实身份信息的引用编号，时间采用带偏移量的 ISO 8601 字符串，附件只记录受控引用或 `sha256` 摘要。业务事件需要携带来源与序列号，后续实现应保留来源系统对事实的责任边界。

## 申诉与解限

- **不可变引用**：`risk_decisions` 以 `decision_ref` 为幂等键接入，载荷摘要（sha256）不一致即拒绝；`adjudications`、`case_events` 由触发器禁止更新与删除，后续再犯不能抹去先前申诉成立的原因。
- **可公开原因类别**：仅限 `proxy_purchase_family`、`payment_mismatch`、`device_cluster`、`velocity_anomaly`、`identity_uncertain`；`rule_revision` 等模型内部信息不进入任何对外视图。
- **最少材料清单**：立案时按原因类别生成（如代购亲属票需关系证明、乘车人实名与支付记录），不多要。
- **敏感证明隔离**：`evidence_items.scope`（intake/review/adjudication）限制可见角色，`retention_until` 到期后清除引用并标记 `purged`。
- **相互制约**：受理/补件（intake_officer）、复核（reviewer）、裁决（adjudicator）分角色；同一处理人在同一案件只能承担一个阶段；处理人登记了案件账号为本人关联账号时必须回避（409 `conflict_of_interest`）；重复案件返回 409 `duplicate_case` 与合并提示。
- **临时放行**：仅作用于明确乘车人、时间窗与购票渠道；到期由清扫逻辑自动置为 `expired` 并生成回收指令。
- **幂等指令与逐项回执**：维持/缩小/撤销及临时放行、回收都生成 `outbound_commands`，`command_id` 为幂等键；重试只增加 `attempt_count`；回执按节点去重，全部 `applied` 才置 `completed`，且只允许 `sent → completed` 单次跃迁。
- **关闭一致性证明**：关闭前必须满足——裁决已记录、全部指令已 `completed`、全部通知已送达、无生效中的临时放行，并写入 `closure_checks` 留痕。
- **时限与误伤**：案件 SLA 为 72 小时，主管通过 `/supervisor/backlog` 发现积压，通过 `/supervisor/repeat-harm` 发现同一账号反复误伤（≥2 次裁决撤销）。
