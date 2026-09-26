# 铁路异常购票分级处置引擎 + 购票申诉与解限后端

本仓库包含两个相互独立、通过脱敏引用与 HTTP 协议交互的服务：

| 服务 | 位置 | 默认端口 | 数据库 |
| --- | --- | --- | --- |
| 原执行节点（风控引擎） | 仓库根目录 | 8080 | `data/app.sqlite3` |
| 申诉与解限后端 | `appeal/` | 8090 | `appeal/data/appeal.sqlite3` |

购票账号、乘车人关系、支付主体、设备证明和处置决定使用脱敏引用。申诉服务只持有风控决定的不可变引用（`decision_ref`）与可公开原因类别，模型阈值与内部规则版本不离开引擎；引擎侧接口、幂等指令协议见下，申诉服务设计见 [`appeal/README.md`](appeal/README.md)，领域边界见 [`docs/domain.md`](docs/domain.md)。

## 引擎侧接口

- `POST /internal/decisions`（内部令牌）：外部风控系统写入决定与初始渠道状态。
- `GET /public/decisions/:ref`：公开视图，仅可公开原因类别与各渠道实际状态。
- `POST /decisions/:ref/commands`（服务令牌 + `Idempotency-Key`）：执行维持/解除/限制指令，同键重试只生效一次，返回逐项回执。
- `POST /internal/reclaim`（内部令牌）：到期临时放行回收（后台 30 秒兜底扫描）。

## 本地开发

```bash
make migrate            # 引擎库迁移
make migrate-appeal     # 申诉库迁移
make test               # 引擎测试
make test-appeal        # 申诉端到端测试（11 个场景，含双真实服务联调）
make run                # 引擎（8080）
make run-appeal         # 申诉（8090，需引擎在运行）
docker compose up --build   # 双服务容器，端口可用 ENGINE_PORT / APPEAL_PORT 调整
```

服务通过 HTTP 接口交换业务事件，并各自使用 SQLite 文件保存本地状态。监听端口由 `PORT` 指定，引擎数据文件由 `DATABASE_PATH` 指定、申诉库由 `APPEAL_DATABASE_PATH` 指定；`contracts/` 记录稳定字段，`fixtures/example.json` 提供不含真实身份信息的示例。
