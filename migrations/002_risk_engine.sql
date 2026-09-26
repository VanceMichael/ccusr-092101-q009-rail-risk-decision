-- 原执行节点（风控引擎）：外部风控决定、各售票渠道实际限制状态、申诉侧幂等指令
-- 申诉服务只持有 decision_ref 的不可变引用；rule_revision 等内部字段不通过任何公开视图离开本服务。

-- 外部风控决定（一旦写入不可修改；修正只能产生新的决定引用，由来源系统承担事实责任）
CREATE TABLE IF NOT EXISTS risk_decisions (
    decision_ref    TEXT PRIMARY KEY,
    account_token   TEXT NOT NULL,
    passenger_token TEXT NOT NULL,
    reason_public   TEXT NOT NULL,          -- 可公开原因类别，不含任何阈值
    rule_revision   INTEGER NOT NULL,       -- 内部规则版本，仅本服务可见
    decided_at      TEXT NOT NULL,
    created_at      TEXT NOT NULL
);

-- 各售票渠道的实际限制状态（裁决对账以此为准）
CREATE TABLE IF NOT EXISTS channel_restrictions (
    decision_ref       TEXT NOT NULL REFERENCES risk_decisions(decision_ref),
    channel            TEXT NOT NULL,
    state              TEXT NOT NULL CHECK (state IN ('restricted', 'released')),
    release_expires_at TEXT,                -- 临时放行到期时间；到期后有效状态自动恢复 restricted
    etag               INTEGER NOT NULL DEFAULT 0,
    updated_at         TEXT NOT NULL,
    PRIMARY KEY (decision_ref, channel)
);

-- 申诉侧指令批次：同一 Idempotency-Key 的网络重试只执行一次，首次回执原样重放
CREATE TABLE IF NOT EXISTS command_batches (
    idempotency_key TEXT PRIMARY KEY,
    case_ref        TEXT NOT NULL,
    decision_ref    TEXT NOT NULL,
    commands_hash   TEXT NOT NULL,          -- 幂等键与请求体绑定：同键不同体直接拒绝
    receipts_json   TEXT NOT NULL,          -- 逐项回执（channel 粒度）
    created_at      TEXT NOT NULL,
    repeated_at     TEXT
);
