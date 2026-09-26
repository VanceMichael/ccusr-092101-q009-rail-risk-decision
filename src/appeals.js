"use strict";

const crypto = require("node:crypto");

// 申诉处理时限（主管据此发现积压）
const SLA_HOURS = 72;

// 可公开原因类别 → 最少材料清单。旅客只能看到这些类别，永远看不到模型阈值。
const REASON_CATEGORIES = {
  proxy_purchase_family: ["relationship_proof", "passenger_realname", "payment_record"],
  payment_mismatch: ["payment_record", "payer_identity"],
  device_cluster: ["device_ownership", "identity_confirmation"],
  velocity_anomaly: ["identity_confirmation"],
  identity_uncertain: ["identity_confirmation", "passenger_realname"],
};

const STAFF_ROLES = new Set(["intake_officer", "reviewer", "adjudicator", "supervisor"]);
const STAGE_ROLE = { intake: "intake_officer", review: "reviewer", adjudication: "adjudicator" };

// 敏感证明授权范围：数值越小越敏感，角色只能读到不超过自身级别的证明
const SCOPE_LEVEL = { intake: 1, review: 2, adjudication: 3 };
const ROLE_SCOPE_LEVEL = { intake_officer: 1, reviewer: 2, adjudicator: 3, supervisor: 3 };

// 状态机：受理/补件由 intake_officer，复核由 reviewer，裁决由 adjudicator
const TRANSITIONS = {
  accept: { stage: "intake", from: ["opened", "evidence_pending"], to: "accepted" },
  request_supplement: { stage: "intake", from: ["accepted"], to: "evidence_pending" },
  review: { stage: "review", from: ["accepted"], to: "under_review" },
  adjudicate: { stage: "adjudication", from: ["under_review"], to: "executing" },
};

const ADJUDICATION_OUTCOMES = new Set(["maintain", "narrow", "revoke"]);

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function createService(db, now) {
  const ts = () => now();

  // ---------- 基础读取 ----------

  function getStaff(actorId) {
    const row = db.prepare("SELECT * FROM staff_profiles WHERE actor_id = ?").get(actorId);
    if (!row) return null;
    return { ...row, linked_account_tokens: JSON.parse(row.linked_account_tokens) };
  }

  function mustGetCase(caseId) {
    const row = db.prepare("SELECT * FROM appeal_cases WHERE case_id = ?").get(caseId);
    if (!row) throw new ApiError(404, "case_not_found", "申诉案件不存在");
    return row;
  }

  function getDecision(decisionRef) {
    return db.prepare("SELECT * FROM risk_decisions WHERE decision_ref = ?").get(decisionRef);
  }

  function decisionNodes(decision) {
    return JSON.parse(decision.restriction_scope).nodes;
  }

  function addEvent(caseId, eventType, actor, detail, isPublic) {
    db.prepare(
      `INSERT INTO case_events (case_id, event_type, actor_id, actor_role, detail, public, created_at)
       VALUES (?,?,?,?,?,?,?)`
    ).run(
      caseId,
      eventType,
      actor ? actor.actor_id : null,
      actor ? actor.role : null,
      JSON.stringify(detail || {}),
      isPublic ? 1 : 0,
      ts()
    );
  }

  // 模拟通知网关：同步发送并记录送达结果；真实部署中替换为网关回调，
  // 但 notifications 表仍是关闭案件前必须核对的送达凭证。
  function notify(caseId, kind, payload) {
    const notificationId = `NT-${crypto.randomUUID()}`;
    db.prepare(
      `INSERT INTO notifications (notification_id, case_id, kind, payload, status, created_at, sent_at)
       VALUES (?,?,?,?,'sent',?,?)`
    ).run(notificationId, caseId, kind, JSON.stringify(payload), ts(), ts());
    return notificationId;
  }

  // command_id 即幂等键：同一业务效果重复建令只会落一行
  function createCommand(caseId, commandId, effect, scope) {
    db.prepare(
      `INSERT OR IGNORE INTO outbound_commands (command_id, case_id, effect, scope, status, attempt_count, created_at)
       VALUES (?,?,?,?,'pending',0,?)`
    ).run(commandId, caseId, effect, JSON.stringify(scope), ts());
  }

  // ---------- 相互制约 ----------

  function assertNoConflict(actor, kase) {
    if (actor.linked_account_tokens.includes(kase.account_token)) {
      throw new ApiError(409, "conflict_of_interest", "处理人与案件账号存在关联，必须回避", {
        actor_id: actor.actor_id,
        account_token: kase.account_token,
      });
    }
  }

  function assertSeparation(caseId, stage, actorId) {
    const prior = db
      .prepare("SELECT stage FROM case_actions WHERE case_id = ? AND actor_id = ?")
      .all(caseId, actorId);
    if (prior.length > 0) {
      throw new ApiError(409, "separation_of_duties", "同一处理人不得在同一案件跨阶段操作", {
        actor_id: actorId,
        already_acted: prior.map((row) => row.stage),
      });
    }
    const done = db
      .prepare("SELECT actor_id FROM case_actions WHERE case_id = ? AND stage = ?")
      .get(caseId, stage);
    if (done) {
      throw new ApiError(409, "stage_already_done", "该阶段已由他人完成", { actor_id: done.actor_id });
    }
  }

  // ---------- 工作人员登记 ----------

  function registerStaff(body) {
    const { actor_id: actorId, role } = body || {};
    if (!actorId || !STAFF_ROLES.has(role)) {
      throw new ApiError(400, "invalid_staff", "actor_id 必填，role 必须为 intake_officer/reviewer/adjudicator/supervisor");
    }
    const linked = Array.isArray(body.linked_account_tokens) ? body.linked_account_tokens : [];
    db.prepare(
      "INSERT OR IGNORE INTO staff_profiles (actor_id, role, linked_account_tokens) VALUES (?,?,?)"
    ).run(actorId, role, JSON.stringify(linked));
    return getStaff(actorId);
  }

  // ---------- 风控决定接入（不可变引用 + 可公开原因类别） ----------

  function ingestDecision(body) {
    const required = [
      "decision_ref",
      "source",
      "source_seq",
      "account_token",
      "public_reason_category",
      "restriction_scope",
      "rule_revision",
      "decided_at",
    ];
    for (const field of required) {
      if (body[field] === undefined || body[field] === null) {
        throw new ApiError(400, "missing_field", `缺少字段 ${field}`);
      }
    }
    if (!REASON_CATEGORIES[body.public_reason_category]) {
      throw new ApiError(400, "unknown_reason_category", "原因类别不在可公开范围内");
    }
    const nodes = body.restriction_scope && body.restriction_scope.nodes;
    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw new ApiError(400, "invalid_scope", "restriction_scope.nodes 必须为非空数组");
    }
    const payloadHash = crypto.createHash("sha256").update(stableStringify(body)).digest("hex");
    const existing = getDecision(body.decision_ref);
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        throw new ApiError(409, "immutable_conflict", "同一 decision_ref 的风控决定不可变更");
      }
      return { decision: existing, deduplicated: true };
    }
    const reusedSeq = db
      .prepare("SELECT decision_ref FROM risk_decisions WHERE source = ? AND source_seq = ?")
      .get(body.source, String(body.source_seq));
    if (reusedSeq) {
      throw new ApiError(409, "immutable_conflict", `来源序列号已用于 ${reusedSeq.decision_ref}`);
    }
    db.prepare(
      `INSERT INTO risk_decisions
         (decision_ref, source, source_seq, account_token, passenger_token, payer_token, device_token,
          public_reason_category, restriction_scope, rule_revision, decided_at, received_at, payload_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      body.decision_ref,
      body.source,
      String(body.source_seq),
      body.account_token,
      body.passenger_token || null,
      body.payer_token || null,
      body.device_token || null,
      body.public_reason_category,
      JSON.stringify(body.restriction_scope),
      body.rule_revision,
      body.decided_at,
      ts(),
      payloadHash
    );
    return { decision: getDecision(body.decision_ref), deduplicated: false };
  }

  // ---------- 立案（最少材料清单 + 重复案件合并提示） ----------

  function openAppeal(body) {
    const { decision_ref: decisionRef, appellant_token: appellantToken } = body || {};
    if (!decisionRef || !appellantToken) {
      throw new ApiError(400, "missing_field", "decision_ref 与 appellant_token 必填");
    }
    const decision = getDecision(decisionRef);
    if (!decision) throw new ApiError(404, "decision_not_found", "风控决定引用不存在");
    const duplicate = db
      .prepare(
        "SELECT case_id FROM appeal_cases WHERE decision_ref = ? AND status NOT IN ('closed','merged')"
      )
      .get(decisionRef);
    if (duplicate) {
      throw new ApiError(409, "duplicate_case", "该决定已有在办申诉，请合并处理", {
        existing_case_id: duplicate.case_id,
        merge_hint: `可调用 POST /appeals/${duplicate.case_id} 补充材料，或将新案件合并入该案件`,
      });
    }
    const related = db
      .prepare(
        `SELECT case_id FROM appeal_cases
         WHERE appellant_token = ? AND account_token = ? AND status NOT IN ('closed','merged')`
      )
      .all(appellantToken, decision.account_token)
      .map((row) => row.case_id);
    const caseId = `AP-${crypto.randomUUID()}`;
    const createdAt = ts();
    const slaDueAt = new Date(Date.parse(createdAt) + SLA_HOURS * 3600 * 1000).toISOString();
    db.prepare(
      `INSERT INTO appeal_cases
         (case_id, decision_ref, appellant_token, account_token, public_reason_category, status, sla_due_at, created_at)
       VALUES (?,?,?,?,?,'opened',?,?)`
    ).run(caseId, decisionRef, appellantToken, decision.account_token, decision.public_reason_category, slaDueAt, createdAt);
    const checklist = REASON_CATEGORIES[decision.public_reason_category];
    for (const material of checklist) {
      db.prepare("INSERT INTO checklists (case_id, material, created_at) VALUES (?,?,?)").run(caseId, material, createdAt);
    }
    addEvent(caseId, "case_opened", null, { decision_ref: decisionRef, merge_hints: related }, true);
    return { case_id: caseId, status: "opened", sla_due_at: slaDueAt, checklist, merge_hints: related };
  }

  function mergeCases(actor, caseId, intoCaseId) {
    if (actor.role !== "intake_officer") {
      throw new ApiError(403, "forbidden_role", "案件合并需受理角色操作");
    }
    const source = mustGetCase(caseId);
    const target = mustGetCase(intoCaseId);
    if (source.case_id === target.case_id) throw new ApiError(400, "invalid_merge", "案件不能合并到自身");
    if (source.status === "closed" || source.status === "merged") {
      throw new ApiError(409, "invalid_state", "已关闭或已合并的案件不能再合并");
    }
    if (target.status === "closed" || target.status === "merged") {
      throw new ApiError(409, "invalid_state", "不能合并入已关闭或已合并的案件");
    }
    assertNoConflict(actor, source);
    db.prepare("UPDATE appeal_cases SET status = 'merged', merged_into = ? WHERE case_id = ?").run(
      target.case_id,
      source.case_id
    );
    addEvent(source.case_id, "merged", actor, { into_case_id: target.case_id }, true);
    addEvent(target.case_id, "absorbed_merge", actor, { from_case_id: source.case_id }, false);
    return { case_id: source.case_id, status: "merged", merged_into: target.case_id };
  }

  // ---------- 敏感证明（授权范围 + 保留期限） ----------

  function submitEvidence(actor, caseId, body) {
    const kase = mustGetCase(caseId);
    if (!["intake_officer", "reviewer", "adjudicator"].includes(actor.role)) {
      throw new ApiError(403, "forbidden_role", "证明登记需办案角色操作");
    }
    assertNoConflict(actor, kase);
    if (["closed", "merged"].includes(kase.status)) {
      throw new ApiError(409, "invalid_state", "案件已终结，不能再登记证明");
    }
    const { kind, storage_ref: storageRef, scope, retention_until: retentionUntil, submitted_by: submittedBy } = body || {};
    if (!kind || !storageRef || !scope || !retentionUntil || !submittedBy) {
      throw new ApiError(400, "missing_field", "kind/storage_ref/scope/retention_until/submitted_by 必填");
    }
    if (!SCOPE_LEVEL[scope]) throw new ApiError(400, "invalid_scope", "scope 必须为 intake/review/adjudication");
    if (!(Date.parse(retentionUntil) > Date.parse(ts()))) {
      throw new ApiError(400, "invalid_retention", "保留期限必须晚于当前时间");
    }
    const evidenceId = `EV-${crypto.randomUUID()}`;
    db.prepare(
      `INSERT INTO evidence_items (evidence_id, case_id, kind, storage_ref, scope, retention_until, submitted_by, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(evidenceId, caseId, kind, storageRef, scope, retentionUntil, submittedBy, ts());
    addEvent(caseId, "evidence_received", actor, { evidence_id: evidenceId, kind }, true);
    return { evidence_id: evidenceId, case_id: caseId, scope, retention_until: retentionUntil };
  }

  function listEvidence(actor, caseId) {
    mustGetCase(caseId);
    const level = ROLE_SCOPE_LEVEL[actor.role];
    return db
      .prepare("SELECT * FROM evidence_items WHERE case_id = ? ORDER BY created_at")
      .all(caseId)
      .filter((row) => SCOPE_LEVEL[row.scope] <= level)
      .map((row) => ({
        evidence_id: row.evidence_id,
        kind: row.kind,
        scope: row.scope,
        retention_until: row.retention_until,
        submitted_by: row.submitted_by,
        purged: Boolean(row.purged_at),
        storage_ref: row.purged_at ? null : row.storage_ref,
      }));
  }

  // ---------- 分阶段流转 ----------

  function transition(actor, caseId, action, body) {
    const spec = TRANSITIONS[action];
    if (!spec) throw new ApiError(400, "unknown_action", "支持的操作：accept/request_supplement/review/adjudicate");
    const kase = mustGetCase(caseId);
    assertNoConflict(actor, kase);
    assertSeparation(caseId, spec.stage, actor.actor_id);
    if (actor.role !== STAGE_ROLE[spec.stage]) {
      throw new ApiError(403, "forbidden_role", `该步骤需要 ${STAGE_ROLE[spec.stage]} 角色`);
    }
    if (!spec.from.includes(kase.status)) {
      throw new ApiError(409, "invalid_state", `当前状态 ${kase.status} 不允许 ${action}`);
    }
    db.exec("BEGIN");
    try {
      db.prepare("INSERT INTO case_actions (case_id, stage, actor_id, acted_at) VALUES (?,?,?,?)").run(
        caseId,
        spec.stage,
        actor.actor_id,
        ts()
      );
      if (action === "accept") {
        addEvent(caseId, "accepted", actor, {}, true);
      } else if (action === "request_supplement") {
        addEvent(caseId, "supplement_requested", actor, {
          required_materials: (body && body.required_materials) || [],
        }, true);
      } else if (action === "review") {
        addEvent(caseId, "review_completed", actor, {}, true);
      } else {
        adjudicate(actor, kase, body);
      }
      db.prepare("UPDATE appeal_cases SET status = ? WHERE case_id = ?").run(spec.to, caseId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return mustGetCase(caseId);
  }

  function adjudicate(actor, kase, body) {
    const { outcome, rationale } = body || {};
    if (!ADJUDICATION_OUTCOMES.has(outcome)) {
      throw new ApiError(400, "invalid_outcome", "裁决结果必须为 maintain/narrow/revoke");
    }
    if (!rationale || typeof rationale !== "string") {
      throw new ApiError(400, "missing_rationale", "必须记录裁决理由，后续再犯不得抹去先前申诉成立的原因");
    }
    const decision = getDecision(kase.decision_ref);
    const nodes = decisionNodes(decision);
    let narrowed = null;
    if (outcome === "narrow") {
      narrowed = body.narrowed_scope;
      if (!narrowed || !Array.isArray(narrowed.nodes) || narrowed.nodes.length === 0) {
        throw new ApiError(400, "invalid_narrowed_scope", "缩小限制必须给出 nodes");
      }
      if (!narrowed.nodes.every((node) => nodes.includes(node))) {
        throw new ApiError(400, "invalid_narrowed_scope", "缩小范围必须是原执行节点的子集");
      }
    }
    db.prepare(
      `INSERT INTO adjudications (case_id, outcome, rationale, narrowed_scope, adjudicated_by, adjudicated_at)
       VALUES (?,?,?,?,?,?)`
    ).run(
      kase.case_id,
      outcome,
      rationale,
      narrowed ? JSON.stringify(narrowed) : null,
      actor.actor_id,
      ts()
    );
    // 维持、缩小、撤销都要向原执行节点发幂等指令
    const scope = {
      decision_ref: kase.decision_ref,
      account_token: kase.account_token,
      nodes: narrowed ? narrowed.nodes : nodes,
    };
    if (narrowed) scope.narrowed_scope = narrowed;
    createCommand(kase.case_id, `${kase.case_id}:adj`, outcome, scope);
    addEvent(kase.case_id, "adjudicated", actor, { outcome }, true);
    notify(kase.case_id, "adjudication_result", { case_id: kase.case_id, outcome });
  }

  // ---------- 临时放行（明确乘车人/时间窗/渠道，到期自动回收） ----------

  function createTempRelease(actor, caseId, body) {
    const kase = mustGetCase(caseId);
    if (!["intake_officer", "reviewer"].includes(actor.role)) {
      throw new ApiError(403, "forbidden_role", "临时放行需受理或复核角色操作");
    }
    assertNoConflict(actor, kase);
    if (!["accepted", "evidence_pending", "under_review", "executing"].includes(kase.status)) {
      throw new ApiError(409, "invalid_state", `当前状态 ${kase.status} 不可临时放行`);
    }
    const { passenger_token: passengerToken, channel, valid_from: validFrom, valid_until: validUntil } = body || {};
    if (!passengerToken || !channel || !validFrom || !validUntil) {
      throw new ApiError(400, "missing_field", "乘车人、渠道与起止时间必填");
    }
    if (!(Date.parse(validUntil) > Date.parse(validFrom)) || Date.parse(validUntil) <= Date.parse(ts())) {
      throw new ApiError(400, "invalid_window", "放行时间窗不合法或已到期");
    }
    const releaseId = `TR-${crypto.randomUUID()}`;
    db.exec("BEGIN");
    try {
      db.prepare(
        `INSERT INTO temp_releases
           (release_id, case_id, passenger_token, channel, valid_from, valid_until, status, created_by, created_at)
         VALUES (?,?,?,?,?,?,'active',?,?)`
      ).run(releaseId, caseId, passengerToken, channel, validFrom, validUntil, actor.actor_id, ts());
      createCommand(caseId, `trg:${releaseId}`, "temp_release", {
        nodes: [channel],
        passenger_token: passengerToken,
        channel,
        valid_from: validFrom,
        valid_until: validUntil,
      });
      addEvent(caseId, "temp_release_granted", actor, {
        release_id: releaseId,
        passenger_token: passengerToken,
        channel,
        valid_until: validUntil,
      }, true);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return db.prepare("SELECT * FROM temp_releases WHERE release_id = ?").get(releaseId);
  }

  // ---------- 到期回收与证明清除（幂等） ----------

  function sweep() {
    const nowMs = Date.parse(ts());
    const expired = db
      .prepare("SELECT * FROM temp_releases WHERE status = 'active'")
      .all()
      .filter((release) => Date.parse(release.valid_until) <= nowMs);
    const purgeable = db
      .prepare("SELECT evidence_id, retention_until FROM evidence_items WHERE purged_at IS NULL")
      .all()
      .filter((row) => Date.parse(row.retention_until) <= nowMs);
    db.exec("BEGIN");
    try {
      for (const release of expired) {
        db.prepare("UPDATE temp_releases SET status = 'expired' WHERE release_id = ? AND status = 'active'").run(
          release.release_id
        );
        createCommand(release.case_id, `trx:${release.release_id}`, "temp_release_expire", {
          nodes: [release.channel],
          passenger_token: release.passenger_token,
          channel: release.channel,
        });
        addEvent(release.case_id, "temp_release_expired", null, { release_id: release.release_id }, true);
      }
      for (const row of purgeable) {
        db.prepare(
          "UPDATE evidence_items SET purged_at = ?, storage_ref = 'purged' WHERE evidence_id = ? AND purged_at IS NULL"
        ).run(ts(), row.evidence_id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { expired_releases: expired.map((release) => release.release_id) };
  }

  // ---------- 指令下发与逐项回执（网络重试不重复变更状态） ----------

  function dispatchCommands() {
    const due = db
      .prepare("SELECT * FROM outbound_commands WHERE status IN ('pending','sent','failed') ORDER BY created_at")
      .all();
    db.exec("BEGIN");
    try {
      for (const command of due) {
        // 重试只增加尝试计数并重新置为 sent，不新增指令、不改变业务效果
        db.prepare(
          "UPDATE outbound_commands SET status = 'sent', attempt_count = attempt_count + 1 WHERE command_id = ?"
        ).run(command.command_id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return due.map((row) => ({ ...row, scope: JSON.parse(row.scope) }));
  }

  function postReceipt(commandId, body) {
    const command = db.prepare("SELECT * FROM outbound_commands WHERE command_id = ?").get(commandId);
    if (!command) throw new ApiError(404, "command_not_found", "指令不存在");
    const { node_id: nodeId, result, detail } = body || {};
    const nodes = JSON.parse(command.scope).nodes;
    if (!nodeId || !nodes.includes(nodeId)) {
      throw new ApiError(400, "unknown_node", "回执节点不在指令目标范围内");
    }
    if (!["applied", "rejected"].includes(result)) {
      throw new ApiError(400, "invalid_result", "result 必须为 applied/rejected");
    }
    const existing = db
      .prepare("SELECT * FROM command_receipts WHERE command_id = ? AND node_id = ?")
      .get(commandId, nodeId);
    if (existing) {
      return { command_id: commandId, node_id: nodeId, deduplicated: true, receipt: existing };
    }
    db.exec("BEGIN");
    try {
      db.prepare(
        "INSERT INTO command_receipts (command_id, node_id, result, detail, received_at) VALUES (?,?,?,?,?)"
      ).run(commandId, nodeId, result, detail || null, ts());
      const receipts = db
        .prepare("SELECT node_id, result FROM command_receipts WHERE command_id = ?")
        .all(commandId);
      if (receipts.some((receipt) => receipt.result === "rejected")) {
        db.prepare("UPDATE outbound_commands SET status = 'failed' WHERE command_id = ? AND status = 'sent'").run(commandId);
      } else if (nodes.every((node) => receipts.some((receipt) => receipt.node_id === node && receipt.result === "applied"))) {
        // 仅允许 sent → completed 单次跃迁，重复回执不会重复变更
        db.prepare(
          "UPDATE outbound_commands SET status = 'completed', completed_at = ? WHERE command_id = ? AND status = 'sent'"
        ).run(ts(), commandId);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return {
      command_id: commandId,
      node_id: nodeId,
      deduplicated: false,
      command: db.prepare("SELECT * FROM outbound_commands WHERE command_id = ?").get(commandId),
    };
  }

  // ---------- 关闭前一致性证明 ----------

  function consistencyReport(caseId) {
    const adjudication = db.prepare("SELECT case_id FROM adjudications WHERE case_id = ?").get(caseId);
    const incomplete = db
      .prepare("SELECT command_id FROM outbound_commands WHERE case_id = ? AND status != 'completed'")
      .all(caseId)
      .map((row) => row.command_id);
    const unsent = db
      .prepare("SELECT notification_id FROM notifications WHERE case_id = ? AND status != 'sent'")
      .all(caseId)
      .map((row) => row.notification_id);
    const activeReleases = db
      .prepare("SELECT release_id FROM temp_releases WHERE case_id = ? AND status = 'active'")
      .all(caseId)
      .map((row) => row.release_id);
    const report = {
      adjudication_recorded: Boolean(adjudication),
      commands_completed: incomplete.length === 0,
      incomplete_commands: incomplete,
      notifications_sent: unsent.length === 0,
      unsent_notifications: unsent,
      temp_releases_clear: activeReleases.length === 0,
      active_releases: activeReleases,
    };
    report.consistent =
      report.adjudication_recorded &&
      report.commands_completed &&
      report.notifications_sent &&
      report.temp_releases_clear;
    return report;
  }

  function closeCase(actor, caseId) {
    const kase = mustGetCase(caseId);
    if (!["adjudicator", "supervisor"].includes(actor.role)) {
      throw new ApiError(403, "forbidden_role", "关闭案件需裁决或主管角色操作");
    }
    if (kase.status === "closed") throw new ApiError(409, "invalid_state", "案件已关闭");
    if (kase.status !== "executing") throw new ApiError(409, "invalid_state", "案件尚未裁决，不能关闭");
    sweep();
    const report = consistencyReport(caseId);
    if (!report.consistent) {
      throw new ApiError(422, "inconsistent_state", "裁决、各渠道限制状态或通知结果不一致，禁止关闭", report);
    }
    db.exec("BEGIN");
    try {
      db.prepare(
        `INSERT INTO closure_checks
           (case_id, adjudication_consistent, commands_consistent, notifications_consistent, temp_releases_clear, checked_at)
         VALUES (?,?,?,?,?,?)`
      ).run(caseId, 1, 1, 1, 1, ts());
      db.prepare("UPDATE appeal_cases SET status = 'closed', closed_at = ? WHERE case_id = ?").run(ts(), caseId);
      addEvent(caseId, "case_closed", actor, {}, true);
      notify(caseId, "case_closed", { case_id: caseId });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { case_id: caseId, status: "closed", closure_check: report };
  }

  // ---------- 视图 ----------

  function getChecklist(caseId) {
    return db
      .prepare("SELECT material FROM checklists WHERE case_id = ? ORDER BY material")
      .all(caseId)
      .map((row) => row.material);
  }

  // 工作人员视图：含指令与回执，但不含模型阈值（rule_revision 不出库）
  function staffCaseView(actor, caseId) {
    const kase = mustGetCase(caseId);
    const decision = getDecision(kase.decision_ref);
    const adjudication = db.prepare("SELECT * FROM adjudications WHERE case_id = ?").get(caseId);
    const commands = db
      .prepare("SELECT * FROM outbound_commands WHERE case_id = ? ORDER BY created_at")
      .all(caseId)
      .map((command) => ({
        ...command,
        scope: JSON.parse(command.scope),
        receipts: db.prepare("SELECT * FROM command_receipts WHERE command_id = ?").all(command.command_id),
      }));
    return {
      case: kase,
      decision: {
        decision_ref: decision.decision_ref,
        account_token: decision.account_token,
        passenger_token: decision.passenger_token,
        device_token: decision.device_token,
        public_reason_category: decision.public_reason_category,
        restriction_scope: JSON.parse(decision.restriction_scope),
        decided_at: decision.decided_at,
      },
      checklist: getChecklist(caseId),
      adjudication: adjudication || null,
      evidence: listEvidence(actor, caseId),
      temp_releases: db.prepare("SELECT * FROM temp_releases WHERE case_id = ?").all(caseId),
      commands,
      events: db.prepare("SELECT * FROM case_events WHERE case_id = ? ORDER BY event_id").all(caseId),
      closure_check: db.prepare("SELECT * FROM closure_checks WHERE case_id = ?").get(caseId) || null,
    };
  }

  // 旅客视图：只含可申诉的事实与进度，不含阈值、设备与内部处理人信息
  function passengerView(caseId, appellantToken) {
    const kase = db.prepare("SELECT * FROM appeal_cases WHERE case_id = ?").get(caseId);
    if (!kase || !appellantToken || kase.appellant_token !== appellantToken) {
      throw new ApiError(404, "case_not_found", "申诉案件不存在");
    }
    const adjudication = db.prepare("SELECT outcome, adjudicated_at FROM adjudications WHERE case_id = ?").get(caseId);
    const progress = db
      .prepare("SELECT event_type, detail, created_at FROM case_events WHERE case_id = ? AND public = 1 ORDER BY event_id")
      .all(caseId)
      .map((row) => ({ event_type: row.event_type, detail: JSON.parse(row.detail), created_at: row.created_at }));
    return {
      case_id: kase.case_id,
      status: kase.status,
      public_reason_category: kase.public_reason_category,
      created_at: kase.created_at,
      sla_due_at: kase.sla_due_at,
      checklist: getChecklist(caseId),
      adjudication: adjudication || null,
      temp_releases: db
        .prepare(
          "SELECT passenger_token, channel, valid_from, valid_until, status FROM temp_releases WHERE case_id = ?"
        )
        .all(caseId),
      progress,
    };
  }

  function supervisorBacklog() {
    const open = db
      .prepare("SELECT case_id, status, sla_due_at, created_at FROM appeal_cases WHERE status NOT IN ('closed','merged')")
      .all();
    const nowMs = Date.parse(ts());
    const overdue = open.filter((kase) => Date.parse(kase.sla_due_at) <= nowMs);
    const byStatus = {};
    for (const kase of open) byStatus[kase.status] = (byStatus[kase.status] || 0) + 1;
    return { now: ts(), sla_hours: SLA_HOURS, overdue_count: overdue.length, overdue, open_by_status: byStatus };
  }

  // 反复误伤：同一账号两次及以上申诉成立（裁决撤销限制）
  function repeatHarm() {
    return db
      .prepare(
        `SELECT c.account_token AS account_token, COUNT(*) AS revoked_count,
                GROUP_CONCAT(a.case_id) AS case_ids
         FROM adjudications a JOIN appeal_cases c ON c.case_id = a.case_id
         WHERE a.outcome = 'revoke'
         GROUP BY c.account_token
         HAVING COUNT(*) >= 2`
      )
      .all();
  }

  return {
    getStaff,
    registerStaff,
    ingestDecision,
    openAppeal,
    mergeCases,
    submitEvidence,
    listEvidence,
    transition,
    createTempRelease,
    sweep,
    dispatchCommands,
    postReceipt,
    consistencyReport,
    closeCase,
    staffCaseView,
    passengerView,
    supervisorBacklog,
    repeatHarm,
  };
}

module.exports = { createService, ApiError, REASON_CATEGORIES };
