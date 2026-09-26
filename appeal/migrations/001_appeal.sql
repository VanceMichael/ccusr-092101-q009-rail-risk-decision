-- 铁路购票申诉与解限后端（独立库，独立部署）
-- 仅保存外部风控决定的不可变引用（decision_ref）与可公开原因类别；
-- 不保存、不请求模型阈值、评分或内部规则版本。

CREATE TABLE IF NOT EXISTS staff_links (
    actor_id      TEXT NOT NULL,
    account_token TEXT NOT NULL,           -- 坐席本人关联账号（利益冲突判定）
    created_at    TEXT NOT NULL,
    PRIMARY KEY (actor_id, account_token)
);

CREATE TABLE IF NOT EXISTS cases (
    case_ref        TEXT PRIMARY KEY,
    access_token    TEXT NOT NULL,         -- 旅客查询凭据，随案件创建一次性签发
    decision_ref    TEXT NOT NULL,         -- 外部风控决定的不可变引用
    account_token   TEXT NOT NULL,
    passenger_token TEXT NOT NULL,
    reason_public   TEXT NOT NULL,         -- 可公开原因类别快照
    fact_snapshot   TEXT NOT NULL,         -- 可申诉事实快照（决定时间、受限渠道），不含阈值
    contact_token   TEXT,                  -- 通知地址引用（脱敏）
    status          TEXT NOT NULL,         -- intake/supplement_pending/in_review/reviewed/resolved/closed/merged
    resolution      TEXT,                  -- overturned|narrowed|maintained（终局理由长期保留）
    rationale       TEXT,
    intake_actor    TEXT,
    review_actor    TEXT,
    adjudicator     TEXT,
    duplicate_of    TEXT,
    merged_into     TEXT,
    conflict_flag   INTEGER NOT NULL DEFAULT 0,
    due_at          TEXT,                  -- 当前阶段 SLA 时限
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    adjudicated_at  TEXT,
    closed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_passenger ON cases(passenger_token);
CREATE INDEX IF NOT EXISTS idx_cases_decision ON cases(decision_ref);

-- 追加写事件账本：任何 UPDATE/DELETE 都被数据库拒绝（后续再犯也无法抹去先前申诉为何成立）
CREATE TABLE IF NOT EXISTS case_events (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    case_ref    TEXT NOT NULL,
    type        TEXT NOT NULL,
    actor       TEXT NOT NULL,            -- system 表示系统动作
    at          TEXT NOT NULL,
    payload     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_case ON case_events(case_ref, seq);
CREATE TRIGGER IF NOT EXISTS trg_case_events_no_update BEFORE UPDATE ON case_events
BEGIN
    SELECT RAISE(ABORT, 'case_events 不可修改');
END;
CREATE TRIGGER IF NOT EXISTS trg_case_events_no_delete BEFORE DELETE ON case_events
BEGIN
    SELECT RAISE(ABORT, 'case_events 不可删除');
END;

CREATE TABLE IF NOT EXISTS checklist_items (
    case_ref      TEXT NOT NULL REFERENCES cases(case_ref),
    material_code TEXT NOT NULL,
    label         TEXT NOT NULL,
    kind          TEXT NOT NULL,          -- sensitive|standard
    scope         TEXT NOT NULL,          -- 允许访问敏感内容的角色范围
    ordinal       INTEGER NOT NULL,
    document_id   INTEGER,
    received_at   TEXT,
    PRIMARY KEY (case_ref, material_code)
);

CREATE TABLE IF NOT EXISTS documents (
    document_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    case_ref        TEXT NOT NULL REFERENCES cases(case_ref),
    material_code   TEXT NOT NULL,
    kind            TEXT NOT NULL,
    scope           TEXT NOT NULL,
    retention_days  INTEGER NOT NULL,    -- 案件关闭后的保留天数（来自材料目录）
    sha256          TEXT NOT NULL,       -- 摘要长期保留作锚点
    storage_ref     TEXT,                -- 受控引用；保留期到期后清空即不可访问
    submitted_by    TEXT NOT NULL,
    submitted_at    TEXT NOT NULL,
    retention_until TEXT,                -- 关案时计算：closed_at + retention_days
    purged_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_case ON documents(case_ref);

CREATE TABLE IF NOT EXISTS document_access (
    document_id INTEGER NOT NULL REFERENCES documents(document_id),
    actor_id    TEXT NOT NULL,
    purpose     TEXT NOT NULL,
    at          TEXT NOT NULL,
    allowed     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
    case_ref    TEXT PRIMARY KEY REFERENCES cases(case_ref),
    actor       TEXT NOT NULL,
    opinion     TEXT NOT NULL,            -- suggest_overturn|suggest_maintain|suggest_narrow
    rationale   TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS temp_grants (
    grant_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    case_ref         TEXT NOT NULL REFERENCES cases(case_ref),
    passenger_token  TEXT NOT NULL,        -- 临时放行只作用于明确乘车人
    channels         TEXT NOT NULL,        -- 明确购票渠道
    valid_from       TEXT NOT NULL,
    valid_until      TEXT NOT NULL,
    status           TEXT NOT NULL,        -- pending|active|expired|revoked|superseded
    batch_id         INTEGER,              -- 放行指令批次
    reclaim_batch_id INTEGER,              -- 到期回收指令批次
    reason           TEXT,
    created_by       TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    finished_at      TEXT
);

CREATE TABLE IF NOT EXISTS adjudications (
    case_ref        TEXT PRIMARY KEY REFERENCES cases(case_ref),
    actor           TEXT NOT NULL,
    decision        TEXT NOT NULL,        -- overturn|narrow|maintain
    release_channels TEXT NOT NULL,       -- 终局意图：解除渠道清单
    rationale       TEXT NOT NULL,
    created_at      TEXT NOT NULL
);

-- 每渠道终局意图：关案对账以此为期望状态
CREATE TABLE IF NOT EXISTS channel_intents (
    case_ref       TEXT NOT NULL REFERENCES cases(case_ref),
    channel        TEXT NOT NULL,
    intended_state TEXT NOT NULL,         -- released|restricted
    PRIMARY KEY (case_ref, channel)
);

-- 发往原执行节点的指令批次：网络重试复用同一 idempotency_key，状态只允许变更一次
CREATE TABLE IF NOT EXISTS command_batches (
    batch_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    case_ref        TEXT NOT NULL,
    decision_ref    TEXT NOT NULL,
    purpose         TEXT NOT NULL,        -- temp_release|final_adjudication|revoke|reclaim
    commands        TEXT NOT NULL,
    status          TEXT NOT NULL,        -- pending|acked|failed|abandoned
    receipts        TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    created_at      TEXT NOT NULL,
    acked_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_batches_case ON command_batches(case_ref);
CREATE INDEX IF NOT EXISTS idx_batches_status ON command_batches(status);

CREATE TABLE IF NOT EXISTS notifications (
    notification_id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_ref        TEXT NOT NULL REFERENCES cases(case_ref),
    kind            TEXT NOT NULL,        -- sms|app_push|mail
    address_token   TEXT NOT NULL,
    status          TEXT NOT NULL,        -- pending|sent|failed
    provider_ref    TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    created_at      TEXT NOT NULL,
    sent_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_case ON notifications(case_ref);

-- 复核意见与裁决一经作出即终局，不得修改或删除（后续再犯也不能改写先前结论）
CREATE TRIGGER IF NOT EXISTS trg_reviews_no_update BEFORE UPDATE ON reviews
BEGIN
    SELECT RAISE(ABORT, 'reviews 不可修改');
END;
CREATE TRIGGER IF NOT EXISTS trg_reviews_no_delete BEFORE DELETE ON reviews
BEGIN
    SELECT RAISE(ABORT, 'reviews 不可删除');
END;
CREATE TRIGGER IF NOT EXISTS trg_adjudications_no_update BEFORE UPDATE ON adjudications
BEGIN
    SELECT RAISE(ABORT, 'adjudications 不可修改');
END;
CREATE TRIGGER IF NOT EXISTS trg_adjudications_no_delete BEFORE DELETE ON adjudications
BEGIN
    SELECT RAISE(ABORT, 'adjudications 不可删除');
END;
