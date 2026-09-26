
-- 铁路购票申诉与解限后端
-- 约定：所有主体使用脱敏引用编号；时间为带偏移量的 ISO 8601 字符串；
-- 附件只保存受控引用或 sha256 摘要；风控决定、裁决与案件事件一经写入不可更改。

-- 外部风控决定的不可变引用（只含可公开原因类别，不含模型阈值）
CREATE TABLE IF NOT EXISTS risk_decisions (
    decision_ref TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_seq TEXT NOT NULL,
    account_token TEXT NOT NULL,
    passenger_token TEXT,
    payer_token TEXT,
    device_token TEXT,
    public_reason_category TEXT NOT NULL,
    restriction_scope TEXT NOT NULL, -- JSON：{nodes:[受限制售票渠道]}
    rule_revision INTEGER NOT NULL,  -- 仅供内部审计，任何对外视图不得输出
    decided_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    UNIQUE (source, source_seq)
);
CREATE TRIGGER IF NOT EXISTS risk_decisions_no_update BEFORE UPDATE ON risk_decisions
BEGIN SELECT RAISE(ABORT, 'risk_decisions_immutable'); END;
CREATE TRIGGER IF NOT EXISTS risk_decisions_no_delete BEFORE DELETE ON risk_decisions
BEGIN SELECT RAISE(ABORT, 'risk_decisions_immutable'); END;

-- 处理人登记：角色与本人关联账号（用于利益冲突回避）
CREATE TABLE IF NOT EXISTS staff_profiles (
    actor_id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('intake_officer','reviewer','adjudicator','supervisor')),
    linked_account_tokens TEXT NOT NULL DEFAULT '[]' -- JSON 数组
);

-- 申诉案件
CREATE TABLE IF NOT EXISTS appeal_cases (
    case_id TEXT PRIMARY KEY,
    decision_ref TEXT NOT NULL REFERENCES risk_decisions(decision_ref),
    appellant_token TEXT NOT NULL,
    account_token TEXT NOT NULL,
    public_reason_category TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN
        ('opened','accepted','evidence_pending','under_review','executing','merged','closed')),
    sla_due_at TEXT NOT NULL,
    merged_into TEXT,
    created_at TEXT NOT NULL,
    closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_appeal_cases_account ON appeal_cases(account_token, status);

-- 最少材料清单（立案时按可公开原因类别生成，之后只读）
CREATE TABLE IF NOT EXISTS checklists (
    case_id TEXT NOT NULL REFERENCES appeal_cases(case_id),
    material TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (case_id, material)
);

-- 分阶段处理记录：受理/复核/裁决相互制约，同一处理人不得跨阶段
CREATE TABLE IF NOT EXISTS case_actions (
    case_id TEXT NOT NULL REFERENCES appeal_cases(case_id),
    stage TEXT NOT NULL CHECK (stage IN ('intake','review','adjudication')),
    actor_id TEXT NOT NULL,
    acted_at TEXT NOT NULL,
    PRIMARY KEY (case_id, stage)
);

-- 案件事件：只追加，旅客可见行与内部行用 public 区分
CREATE TABLE IF NOT EXISTS case_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL REFERENCES appeal_cases(case_id),
    event_type TEXT NOT NULL,
    actor_id TEXT,
    actor_role TEXT,
    detail TEXT NOT NULL DEFAULT '{}', -- JSON
    public INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_events_case ON case_events(case_id);
CREATE TRIGGER IF NOT EXISTS case_events_no_update BEFORE UPDATE ON case_events
BEGIN SELECT RAISE(ABORT, 'case_events_immutable'); END;
CREATE TRIGGER IF NOT EXISTS case_events_no_delete BEFORE DELETE ON case_events
BEGIN SELECT RAISE(ABORT, 'case_events_immutable'); END;

-- 最终裁决：理由必填且不可更改，后续再犯不得抹去先前申诉成立的原因
CREATE TABLE IF NOT EXISTS adjudications (
    case_id TEXT PRIMARY KEY REFERENCES appeal_cases(case_id),
    outcome TEXT NOT NULL CHECK (outcome IN ('maintain','narrow','revoke')),
    rationale TEXT NOT NULL,
    narrowed_scope TEXT, -- JSON，outcome=narrow 时必填
    adjudicated_by TEXT NOT NULL,
    adjudicated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS adjudications_no_update BEFORE UPDATE ON adjudications
BEGIN SELECT RAISE(ABORT, 'adjudications_immutable'); END;
CREATE TRIGGER IF NOT EXISTS adjudications_no_delete BEFORE DELETE ON adjudications
BEGIN SELECT RAISE(ABORT, 'adjudications_immutable'); END;

-- 敏感证明：按授权范围隔离、按保留期限清除
CREATE TABLE IF NOT EXISTS evidence_items (
    evidence_id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES appeal_cases(case_id),
    kind TEXT NOT NULL,
    storage_ref TEXT NOT NULL, -- 受控引用或 sha256 摘要，清除后写 'purged'
    scope TEXT NOT NULL CHECK (scope IN ('intake','review','adjudication')),
    retention_until TEXT NOT NULL,
    submitted_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    purged_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_case ON evidence_items(case_id);

-- 临时放行：仅作用于明确乘车人、时间窗与购票渠道，到期自动回收
CREATE TABLE IF NOT EXISTS temp_releases (
    release_id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES appeal_cases(case_id),
    passenger_token TEXT NOT NULL,
    channel TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active','expired','revoked')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_temp_releases_case ON temp_releases(case_id, status);

-- 发往原执行节点的幂等指令：command_id 即幂等键，重试不新增、不重复变更
CREATE TABLE IF NOT EXISTS outbound_commands (
    command_id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES appeal_cases(case_id),
    effect TEXT NOT NULL CHECK (effect IN ('maintain','narrow','revoke','temp_release','temp_release_expire')),
    scope TEXT NOT NULL, -- JSON：{nodes:[...], ...}
    status TEXT NOT NULL CHECK (status IN ('pending','sent','completed','failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbound_commands_case ON outbound_commands(case_id, status);

-- 逐项回执：每个执行节点一条，重复回执去重
CREATE TABLE IF NOT EXISTS command_receipts (
    command_id TEXT NOT NULL REFERENCES outbound_commands(command_id),
    node_id TEXT NOT NULL,
    result TEXT NOT NULL CHECK (result IN ('applied','rejected')),
    detail TEXT,
    received_at TEXT NOT NULL,
    PRIMARY KEY (command_id, node_id)
);

-- 旅客通知：关闭案件前必须全部送达
CREATE TABLE IF NOT EXISTS notifications (
    notification_id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES appeal_cases(case_id),
    kind TEXT NOT NULL,
    payload TEXT NOT NULL, -- JSON
    status TEXT NOT NULL CHECK (status IN ('pending','sent')),
    created_at TEXT NOT NULL,
    sent_at TEXT
);

-- 关闭前一致性证明：裁决、各渠道实际限制状态与通知结果一致
CREATE TABLE IF NOT EXISTS closure_checks (
    case_id TEXT PRIMARY KEY REFERENCES appeal_cases(case_id),
    adjudication_consistent INTEGER NOT NULL,
    commands_consistent INTEGER NOT NULL,
    notifications_consistent INTEGER NOT NULL,
    temp_releases_clear INTEGER NOT NULL,
    checked_at TEXT NOT NULL
);
