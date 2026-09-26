# 铁路购票申诉与解限后端

节假日风控加强后，针对“替父母买票却被限制”等误伤的独立申诉服务。与风控引擎物理隔离：只引用外部决定、只核实材料、只按裁决下发幂等解限指令。

## 设计原则

1. **不接触风控秘密**：仅存 `decision_ref` 不可变引用与可公开原因类别；坐席看不到模型阈值/规则版本，也不允许自行重做风险判断。
2. **最少材料清单**：按原因类别（`src/catalog.js`）生成关系、支付、实名三类材料清单；敏感证明（关系证明、代付授权等）仅复核/主管角色可访问内容，受理只见摘要，每次访问留痕。
3. **角色相互制约**：受理（intake_agent）→ 复核（reviewer）→ 裁决（supervisor）三角色强制四眼分离，受理人不能复核自己的案件，裁决人不能是受理人或复核人。
4. **利益冲突与合并**：操作人处理本人关联账号时实时拦截并强制回避；同一决定/同一乘车人重复申诉自动建立合并关系。
5. **临时放行最小化**：只作用于明确乘车人 × 明确渠道 × ≤72 小时时间窗，到期申诉侧与引擎侧双重自动回收。
6. **幂等解限**：维持/缩小/撤销都生成携带 `Idempotency-Key` 的指令批次，网络重试复用同一键，原执行节点只执行一次并重放首次逐项回执；终局裁决后未确认的临时批次自动废弃，迟到重试不能覆盖终局状态。
7. **关案一致性闸门**：关闭前必须同时满足——终局指令批次逐项回执 accepted、回查各渠道实际状态与裁决意图逐项一致、通知全部 sent；任一不满足拒绝关案。
8. **历史不可抹除**：案件事件、复核、裁决由数据库触发器禁止修改/删除；敏感材料按关案后保留期（敏感 30 天/普通 180 天）清除受控引用，`sha256` 摘要锚点长期保留。

## 主要接口

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/staff/cases` | 受理 | 凭 `decision_ref` + 脱敏通知地址立案，返回 `access_token` |
| GET | `/public/cases/:ref` | 旅客（access_token） | 可申诉事实、材料清单、进度时间线（无阈值） |
| POST | `/staff/cases/:ref/documents` | 受理 | 登记材料受控引用与 sha256 |
| POST | `/staff/cases/:ref/document-access` | 任意坐席 | 按授权范围取敏感材料，越权拒绝并留痕 |
| POST | `/staff/cases/:ref/supplement-request` | 受理 | 发起补件并通知旅客 |
| POST | `/staff/cases/:ref/submit-review` | 受理 | 材料齐备后提交复核 |
| POST | `/staff/cases/:ref/reviews` | 复核（须不同人） | 复核意见 |
| POST | `/staff/cases/:ref/temp-grants` | 主管 | 乘车人×渠道×时间窗临时放行 |
| POST | `/staff/cases/:ref/adjudications` | 主管（须第三方） | overturn/narrow/maintain 终局裁决 |
| POST | `/staff/cases/:ref/close` | 主管 | 一致性闸门通过后关案 |
| POST | `/staff/batches/:id/retry` | 坐席 | 同幂等键安全重试指令 |
| GET | `/supervisor/dashboard` | 主管 | SLA 积压、反复误伤、利益冲突队列 |
| POST | `/internal/sweep` | 运维 | 到期放行回收、材料保留期清理 |

## 本地开发

```bash
npm run migrate                 # 初始化申诉库（appeal/data/appeal.sqlite3）
npm test                        # 端到端测试（会同时拉起内存版引擎）
ENGINE_BASE_URL=http://127.0.0.1:8080 npm start   # 默认 8090 端口
```

身份通过 `x-actor-id` / `x-actor-role` 请求头传入（生产应由网关注入并签名）。
