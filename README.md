# 铁路异常购票分级处置引擎 · 申诉与解限后端

购票账号、乘车人关系、支付主体、设备证明和处置决定使用脱敏引用。

本服务在分级处置引擎之上提供独立的申诉与解限后端：接收外部风控决定的**不可变引用**与**可公开原因类别**，为旅客生成最少材料清单，按角色相互制约地完成受理、补件、复核与裁决，并向原执行节点下发幂等指令、等待逐项回执。服务通过 HTTP 接口交换业务事件，使用 SQLite 保存本地状态。监听端口由 `PORT` 指定，数据文件位置由 `DATABASE_PATH` 指定。

## 约定

- 时间一律为带偏移量的 ISO 8601 字符串；附件只记录受控引用或 `sha256` 摘要。
- `rule_revision` 等模型内部信息只存库审计，任何对外视图（含坐席视图）均不输出。
- 处理人通过 `x-actor-id` 请求头标识，须先经 `POST /staff` 登记角色与本人关联账号。

## 主要接口

| 接口 | 说明 |
| --- | --- |
| `POST /risk-decisions` | 接入风控决定引用；同 `decision_ref` 重复接入幂等去重，内容变更返回 409 |
| `POST /appeals` | 立案，返回最少材料清单；重复案件返回 409 与合并提示 |
| `POST /appeals/:id/merge` | 合并重复案件（受理角色） |
| `POST /appeals/:id/evidence` | 登记敏感证明（授权范围 + 保留期限） |
| `POST /appeals/:id/transitions` | `accept` / `request_supplement` / `review` / `adjudicate` 分阶段流转 |
| `POST /appeals/:id/temp-releases` | 临时放行（限定乘车人、时间窗、渠道，到期自动回收） |
| `POST /appeals/:id/close` | 关闭案件（需通过一致性证明） |
| `POST /commands/dispatch` | 下发待执行指令（重试不新增、不重复变更） |
| `POST /commands/:id/receipts` | 执行节点逐项回执（重复回执去重） |
| `GET /passenger/cases/:id?appellant_token=` | 旅客视图：可申诉事实与进度 |
| `GET /supervisor/backlog` | 主管视图：超 72 小时未结积压 |
| `GET /supervisor/repeat-harm` | 主管视图：同一账号反复误伤（≥2 次申诉成立） |
| `GET /appeals/:id` | 办案视图（按角色过滤证明范围） |

## 本地开发

运行 `make migrate` 初始化数据文件，`make test` 执行现有自动化检查，`make run` 启动服务。也可以使用 `docker compose up --build` 构建并运行容器，宿主机端口通过 `APP_PORT` 调整。

`contracts/entities.json` 记录处置引擎的稳定字段，`contracts/appeals.json` 记录申诉后端的稳定字段，`fixtures/` 提供不含真实身份信息的示例。
