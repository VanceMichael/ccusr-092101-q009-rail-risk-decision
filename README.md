# 铁路异常购票分级处置引擎

购票账号、乘车人关系、支付主体、设备证明和处置决定使用脱敏引用。

服务通过 HTTP 接口交换业务事件，并使用 SQLite 文件保存本地状态。监听端口由 `PORT` 指定，数据文件位置由 `DATABASE_PATH` 指定；`contracts/entities.json` 记录首批稳定字段，`fixtures/example.json` 提供不含真实身份信息的示例。

## 本地开发

运行 `make migrate` 初始化数据文件，`make test` 执行现有自动化检查，`make run` 启动服务。也可以使用 `docker compose up --build` 构建并运行容器，宿主机端口通过 `APP_PORT` 调整。
