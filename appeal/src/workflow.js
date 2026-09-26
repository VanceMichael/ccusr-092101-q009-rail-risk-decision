
const { nowIso, addHours, recordEvent, getCase, httpError, assertNoLink } = require("./cases");
const { dispatchBatch, retryBatch } = require("./dispatcher");
const { fetchDecision } = require("./engineClient");

const SLA_STAGE_HOURS = { intake: 48, review: 72, adjudication: 72 };

function assertNotMergedOrClosed(caseRow) {
  if (caseRow.status === "merged") throw httpError(409, "case_merged", `案件已合并至 ${caseRow.merged_into}`);
  if (caseRow.status === "closed") throw httpError(409, "case_closed", "案件已关闭");
}

function requiredItemsMissing(db, caseRef) {
  return db
    .prepare("SELECT material_code FROM checklist_items WHERE case_ref = ? AND document_id IS NULL ORDER BY ordinal")
    .all(caseRef);
}

// 通知创建并投递；失败保留 pending/failed 供重试，关案前必须全部 sent
async function notify(db, notifier, caseRef, kind) {
  const caseRow = getCase(db, caseRef);
  const ts = nowIso();
  const result = db.prepare(
    `INSERT INTO notifications (case_ref, kind, address_token, status, attempts, created_at)
     VALUES (?, ?, ?, 'pending', 0, ?)`,
  ).run(caseRef, kind, caseRow.contact_token || "ANONYMOUS", ts);
  const notificationId = Number(result.lastInsertRowid);
  return attemptNotification(db, notifier, notificationId);
}

async function attemptNotification(db, notifier, notificationId) {
  const row = db.prepare("SELECT * FROM notifications WHERE notification_id = ?").get(notificationId);
  if (row.status === "sent") return row;
  db.prepare("UPDATE notifications SET attempts = attempts + 1, last_error = NULL WHERE notification_id = ?").run(notificationId);
  try {
    const receipt = await notifier.send(row);
    db.prepare(
      "UPDATE notifications SET status = 'sent', provider_ref = ?, sent_at = ?, last_error = NULL WHERE notification_id = ?",
    ).run(receipt.provider_ref, nowIso(), notificationId);
  } catch (error) {
    db.prepare("UPDATE notifications SET status = 'failed', last_error = ? WHERE notification_id = ?").run(
      error.message,
      notificationId,
    );
  }
  return db.prepare("SELECT * FROM notifications WHERE notification_id = ?").get(notificationId);
}

// 受理人提交复核：材料齐备且本人无利益冲突
function submitForReview(db, caseRow, actor) {
  assertNotMergedOrClosed(caseRow);
  assertNoLink(db, caseRow, actor);
  if (actor.role !== "intake_agent") throw httpError(403, "forbidden_role", "仅受理坐席可提交复核");
  if (!["intake", "supplement_pending"].includes(caseRow.status)) {
    throw httpError(409, "invalid_status", `当前状态 ${caseRow.status} 不可提交复核`);
  }
  const missing = requiredItemsMissing(db, caseRow.case_ref);
  if (missing.length > 0) {
    throw httpError(409, "materials_incomplete", `材料未齐：${missing.map((m) => m.material_code).join(",")}`);
  }
  const ts = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "UPDATE cases SET status = 'in_review', due_at = ?, updated_at = ? WHERE case_ref = ?",
    ).run(addHours(ts, SLA_STAGE_HOURS.review), ts, caseRow.case_ref);
    recordEvent(db, caseRow.case_ref, "in_review", actor.id, {}, ts);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { ok: true, status: "in_review" };
}

// 受理人发起补件：旅客公开视图将看到需要补充的具体材料
async function requestSupplement(db, deps, caseRow, actor, body) {
  assertNotMergedOrClosed(caseRow);
  assertNoLink(db, caseRow, actor);
  if (actor.role !== "intake_agent") throw httpError(403, "forbidden_role", "仅受理坐席可发起补件");
  if (!["intake", "supplement_pending"].includes(caseRow.status)) {
    throw httpError(409, "invalid_status", "仅受理阶段可要求补件");
  }
  const items = Array.isArray(body.items) ? body.items : [];
  const valid = new Set(
    db
      .prepare("SELECT material_code FROM checklist_items WHERE case_ref = ? AND document_id IS NULL")
      .all(caseRow.case_ref)
      .map((row) => row.material_code),
  );
  const targets = items.filter((code) => valid.has(code));
  if (targets.length === 0) throw httpError(400, "invalid_request", "没有需要补充的清单材料");

  const ts = nowIso();
  db.prepare("UPDATE cases SET status = 'supplement_pending', due_at = ?, updated_at = ? WHERE case_ref = ?")
    .run(addHours(ts, SLA_STAGE_HOURS.intake), ts, caseRow.case_ref);
  recordEvent(db, caseRow.case_ref, "supplement_requested", actor.id, {
    items: targets,
    reason: body.reason || null,
  }, ts);
  const notification = await notify(db, deps.notifier, caseRow.case_ref, "app_push");
  return { ok: true, status: "supplement_pending", items: targets, notification_id: notification.notification_id };
}

// 复核：必须由不同于受理人的复核人完成，只能在材料与关系事实上发表意见，不重做风险判断
function submitReview(db, caseRow, actor, body) {
  assertNotMergedOrClosed(caseRow);
  assertNoLink(db, caseRow, actor);
  if (actor.role !== "reviewer") throw httpError(403, "forbidden_role", "仅复核人可发表复核意见");
  if (caseRow.status !== "in_review") throw httpError(409, "invalid_status", "案件不在复核阶段");
  if (caseRow.intake_actor === actor.id) {
    throw httpError(403, "segregation_violation", "受理人不能复核自己受理的案件");
  }
  const opinions = new Set(["suggest_overturn", "suggest_maintain", "suggest_narrow"]);
  if (!opinions.has(body.opinion)) throw httpError(400, "invalid_request", "opinion 非法");
  if (typeof body.rationale !== "string" || body.rationale.length < 5) {
    throw httpError(400, "invalid_request", "复核需要说明依据的关系/支付/实名事实");
  }
  if (body.opinion === "suggest_narrow" && !Array.isArray(body.suggested_channels)) {
    throw httpError(400, "invalid_request", "缩小限制需要给出建议解除渠道");
  }
  const ts = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT INTO reviews (case_ref, actor, opinion, rationale, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(caseRow.case_ref, actor.id, body.opinion, body.rationale, ts);
    db.prepare(
      "UPDATE cases SET status = 'reviewed', review_actor = ?, due_at = ?, updated_at = ? WHERE case_ref = ?",
    ).run(actor.id, addHours(ts, SLA_STAGE_HOURS.adjudication), ts, caseRow.case_ref);
    recordEvent(db, caseRow.case_ref, "reviewed", actor.id, { opinion: body.opinion }, ts);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { ok: true, status: "reviewed" };
}

// 最终裁决：主管必须与受理人、复核人均不同；维持/缩小/撤销都生成终局渠道意图并下发幂等指令
async function adjudicate(db, deps, caseRow, actor, body) {
  assertNotMergedOrClosed(caseRow);
  assertNoLink(db, caseRow, actor);
  if (actor.role !== "supervisor") throw httpError(403, "forbidden_role", "仅主管可作出最终裁决");
  if (caseRow.status !== "reviewed") throw httpError(409, "invalid_status", "案件尚未完成复核");
  if (caseRow.intake_actor === actor.id || caseRow.review_actor === actor.id) {
    throw httpError(403, "segregation_violation", "裁决人不得是本案受理人或复核人");
  }
  const decisions = new Set(["overturn", "narrow", "maintain"]);
  if (!decisions.has(body.decision)) throw httpError(400, "invalid_request", "decision 非法");
  if (typeof body.rationale !== "string" || body.rationale.length < 5) {
    throw httpError(400, "invalid_request", "裁决必须说明理由（长期保留，后续不得抹除）");
  }
  const fact = JSON.parse(caseRow.fact_snapshot);
  const restricted = new Set(fact.restricted_channels);
  let releaseChannels;
  if (body.decision === "overturn") {
    releaseChannels = [...restricted];
  } else if (body.decision === "maintain") {
    releaseChannels = [];
  } else {
    releaseChannels = Array.isArray(body.release_channels) ? body.release_channels : [];
    for (const channel of releaseChannels) {
      if (!restricted.has(channel)) {
        throw httpError(400, "channel_not_restricted", `渠道 ${channel} 不在原限制范围，不能缩小到该渠道`);
      }
    }
    const unique = new Set(releaseChannels);
    if (unique.size !== releaseChannels.length) throw httpError(400, "invalid_request", "渠道重复");
    if (releaseChannels.length === 0) throw httpError(400, "invalid_request", "缩小限制至少解除一个渠道，否则应维持");
    if (releaseChannels.length === restricted.size) throw httpError(400, "invalid_request", "全部解除应裁决撤销");
  }
  const releaseSet = new Set(releaseChannels);
  const commands = [...restricted].map((channel) =>
    releaseSet.has(channel)
      ? { channel, action: "release", release_expires_at: null } // 终局解除，无到期时间
      : { channel, action: "restrict" },                        // 维持/缩小时回收任何临时放行
  );

  const ts = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO adjudications (case_ref, actor, decision, release_channels, rationale, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(caseRow.case_ref, actor.id, body.decision, JSON.stringify(releaseChannels), body.rationale, ts);
    for (const channel of restricted) {
      db.prepare(
        "INSERT INTO channel_intents (case_ref, channel, intended_state) VALUES (?, ?, ?)",
      ).run(caseRow.case_ref, channel, releaseSet.has(channel) ? "released" : "restricted");
    }
    // 未被终局解除的活动临时放行即刻作废
    db.prepare(
      `UPDATE temp_grants SET status = 'superseded', finished_at = ?
        WHERE case_ref = ? AND status IN ('active','pending')`,
    ).run(ts, caseRow.case_ref);
    // 终局之后，任何尚未确认的临时放行/回收批次一律废弃，防止迟到重试覆盖终局渠道状态
    db.prepare(
      `UPDATE command_batches SET status = 'abandoned', last_error = 'superseded_by_final_adjudication'
        WHERE case_ref = ? AND status = 'pending' AND purpose IN ('temp_release','reclaim')`,
    ).run(caseRow.case_ref);
    db.prepare(
      "UPDATE cases SET status = 'resolved', resolution = ?, adjudicator = ?, adjudicated_at = ?, due_at = NULL, updated_at = ? WHERE case_ref = ?",
    ).run(body.decision, actor.id, ts, ts, caseRow.case_ref);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const batch = await dispatchBatch(db, deps, {
    caseRef: caseRow.case_ref,
    decisionRef: caseRow.decision_ref,
    purpose: "final_adjudication",
    commands,
  });
  recordEvent(db, caseRow.case_ref, "adjudicated", actor.id, {
    decision: body.decision,
    release_channels: releaseChannels,
    public_note: publicNote(body.decision),
    batch_id: batch.batch_id,
  });
  const notification = await notify(db, deps.notifier, caseRow.case_ref, "app_push");
  return {
    ok: true,
    status: "resolved",
    resolution: body.decision,
    batch_id: batch.batch_id,
    command_status: batch.status,
    receipts: batch.receipts ? JSON.parse(batch.receipts) : null,
    notification_id: notification.notification_id,
    notification_status: notification.status,
  };
}

function publicNote(decision) {
  if (decision === "overturn") return "经核实关系、支付与实名材料，原限制已解除";
  if (decision === "narrow") return "经核实，原限制范围已缩小";
  return "经复核，现有材料不足以解除限制，原限制维持";
}

// 关案一致性闸门：裁决意图 == 各渠道实际状态 == 通知结果，缺一不可
async function closeCase(db, deps, caseRow, actor) {
  if (actor.role !== "supervisor") throw httpError(403, "forbidden_role", "仅主管可关闭案件");
  if (caseRow.status !== "resolved") throw httpError(409, "invalid_status", "裁决尚未作出或案件已关闭");

  const adjudication = db.prepare("SELECT * FROM adjudications WHERE case_ref = ?").get(caseRow.case_ref);
  const finalBatch = db
    .prepare("SELECT * FROM command_batches WHERE case_ref = ? AND purpose = 'final_adjudication' ORDER BY batch_id DESC LIMIT 1")
    .get(caseRow.case_ref);

  const failures = [];
  if (!finalBatch || finalBatch.status !== "acked") {
    failures.push("终局指令批次未获得原执行节点回执");
  } else {
    const receipts = JSON.parse(finalBatch.receipts);
    const rejected = receipts.filter((receipt) => !receipt.accepted);
    if (rejected.length > 0) failures.push(`部分渠道指令被拒：${rejected.map((r) => r.channel).join(",")}`);
  }

  // 与原执行节点的实际渠道状态逐项对账
  let decisionView = null;
  try {
    decisionView = await fetchDecision(deps.engineBaseUrl, caseRow.decision_ref, deps.engineToken);
  } catch (error) {
    failures.push(`无法核对渠道实际状态：${error.message}`);
  }
  const actualByChannel = new Map((decisionView?.channels || []).map((channel) => [channel.channel, channel]));
  const intents = db.prepare("SELECT * FROM channel_intents WHERE case_ref = ?").all(caseRow.case_ref);
  const mismatches = [];
  for (const intent of intents) {
    const actual = actualByChannel.get(intent.channel);
    if (!actual) {
      mismatches.push(`${intent.channel}: 原执行节点无此渠道状态`);
    } else if (actual.state !== intent.intended_state) {
      mismatches.push(`${intent.channel}: 期望 ${intent.intended_state}，实际 ${actual.state}`);
    }
  }
  if (mismatches.length > 0) failures.push(`渠道状态不一致：${mismatches.join("；")}`);

  const pendingNotifications = db
    .prepare("SELECT notification_id, status FROM notifications WHERE case_ref = ? AND status != 'sent'")
    .all(caseRow.case_ref);
  if (pendingNotifications.length > 0) {
    failures.push(`存在未送达通知：${pendingNotifications.map((n) => n.notification_id).join(",")}`);
  }

  if (failures.length > 0) {
    throw httpError(409, "close_gate_failed", failures.join("；"), );
  }

  // 以关闭时间起算保留期：敏感材料 30 天、普通材料 180 天（按材料目录 retention_days）
  const ts = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const docs = db.prepare("SELECT document_id, retention_days FROM documents WHERE case_ref = ? AND purged_at IS NULL").all(caseRow.case_ref);
    for (const doc of docs) {
      db.prepare("UPDATE documents SET retention_until = ? WHERE document_id = ?")
        .run(addHours(ts, doc.retention_days * 24), doc.document_id);
    }
    db.prepare("UPDATE cases SET status = 'closed', closed_at = ?, updated_at = ? WHERE case_ref = ?").run(ts, ts, caseRow.case_ref);
    recordEvent(db, caseRow.case_ref, "closed", actor.id, {
      evidence: {
        batch_id: finalBatch.batch_id,
        receipts: JSON.parse(finalBatch.receipts),
        channel_etags: intents.map((intent) => {
          const actual = actualByChannel.get(intent.channel);
          return { channel: intent.channel, intended: intent.intended_state, etag: actual.etag };
        }),
        notifications_sent: db
          .prepare("SELECT notification_id FROM notifications WHERE case_ref = ? AND status = 'sent'")
          .all(caseRow.case_ref)
          .map((row) => row.notification_id),
      },
    }, ts);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { ok: true, status: "closed", closed_at: ts };
}

// 保留期到期清除受控引用；sha256 摘要锚点保留，敏感内容不可再访问
function purgeExpiredDocuments(db, now = nowIso()) {
  const due = db
    .prepare("SELECT document_id, case_ref FROM documents WHERE purged_at IS NULL AND retention_until IS NOT NULL AND retention_until <= ?")
    .all(now);
  for (const doc of due) {
    db.prepare("UPDATE documents SET storage_ref = NULL, purged_at = ? WHERE document_id = ?").run(now, doc.document_id);
    recordEvent(db, doc.case_ref, "document_purged", "system", { document_id: doc.document_id });
  }
  return due.map((doc) => doc.document_id);
}

// 主管看板：时限积压 + 反复误伤（多次申诉成立的乘车人）+ 利益冲突队列
function supervisorDashboard(db, now = nowIso()) {
  const stages = ["intake", "supplement_pending", "in_review", "reviewed", "resolved"];
  const overdue = db
    .prepare(
      `SELECT case_ref, status, due_at, intake_actor, review_actor, conflict_flag
         FROM cases WHERE status NOT IN ('closed','merged') AND due_at IS NOT NULL AND due_at <= ?
         ORDER BY due_at`,
    )
    .all(now);
  const pendingByStage = {};
  for (const stage of stages) {
    pendingByStage[stage] = db.prepare("SELECT COUNT(*) AS n FROM cases WHERE status = ?").get(stage).n;
  }
  const repeatFalsePositives = db
    .prepare(
      `SELECT passenger_token,
              COUNT(*) AS upheld_appeals,
              GROUP_CONCAT(case_ref) AS case_refs,
              MAX(adjudicated_at) AS last_adjudicated_at
         FROM cases
        WHERE resolution IN ('overturn','narrow')
        GROUP BY passenger_token
       HAVING COUNT(*) >= 2
        ORDER BY upheld_appeals DESC, last_adjudicated_at DESC`,
    )
    .all()
    .map((row) => ({ ...row, case_refs: row.case_refs.split(",") }));
  const conflictQueue = db
    .prepare(
      `SELECT case_ref, status, intake_actor FROM cases
        WHERE conflict_flag = 1 AND status NOT IN ('closed','merged') ORDER BY created_at`,
    )
    .all();
  return { as_of: now, pending_by_stage: pendingByStage, overdue, repeat_false_positives: repeatFalsePositives, conflict_queue: conflictQueue };
}

function staffQueue(db, status) {
  if (status) {
    return db.prepare(
      "SELECT case_ref, status, reason_public, conflict_flag, due_at, created_at FROM cases WHERE status = ? ORDER BY created_at",
    ).all(status);
  }
  return db.prepare(
    "SELECT case_ref, status, reason_public, conflict_flag, due_at, created_at FROM cases WHERE status NOT IN ('closed','merged') ORDER BY created_at",
  ).all();
}

module.exports = {
  SLA_STAGE_HOURS,
  submitForReview,
  requestSupplement,
  submitReview,
  adjudicate,
  closeCase,
  purgeExpiredDocuments,
  supervisorDashboard,
  staffQueue,
  attemptNotification,
  retryBatch,
  notify,
};
