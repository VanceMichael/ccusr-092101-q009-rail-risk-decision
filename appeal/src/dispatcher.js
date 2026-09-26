
const crypto = require("node:crypto");
const { EngineError, postCommands } = require("./engineClient");
const { nowIso, addHours, recordEvent, getCase, httpError, assertNoLink } = require("./cases");

const CHANNELS = ["app", "web", "window", "agent_terminal"];
const MAX_GRANT_HOURS = 72;

function newIdempotencyKey() {
  return `K-${crypto.randomBytes(12).toString("hex")}`;
}

// 创建批次并尝试一次投递；网络失败只留下 pending + 同一幂等键，供重试
async function dispatchBatch(db, deps, params) {
  const { caseRef, decisionRef, purpose, commands } = params;
  const key = newIdempotencyKey();
  const ts = nowIso();
  const result = db.prepare(
    `INSERT INTO command_batches
       (idempotency_key, case_ref, decision_ref, purpose, commands, status, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
  ).run(key, caseRef, decisionRef, purpose, JSON.stringify(commands), ts);
  const batchId = Number(result.lastInsertRowid);
  return attemptBatch(db, deps, batchId);
}

// 使用同一幂等键重试：引擎去重，绝不重复变更状态
async function attemptBatch(db, deps, batchId) {
  const batch = db.prepare("SELECT * FROM command_batches WHERE batch_id = ?").get(batchId);
  if (!batch) throw httpError(404, "batch_not_found");
  if (batch.status === "acked") return batch;
  if (batch.status === "abandoned") throw httpError(409, "batch_abandoned", "批次已被终局裁决废弃，不得再投递");
  if (batch.status === "failed") throw httpError(409, "batch_failed", "批次被原执行节点拒绝，不得原样重试");

  db.prepare("UPDATE command_batches SET attempts = attempts + 1, last_error = NULL WHERE batch_id = ?").run(batchId);
  try {
    const body = await postCommands(
      deps.engineBaseUrl,
      batch.decision_ref,
      deps.engineToken,
      { case_ref: batch.case_ref, commands: JSON.parse(batch.commands) },
      batch.idempotency_key,
    );
    const ts = nowIso();
    db.prepare(
      "UPDATE command_batches SET status = 'acked', receipts = ?, acked_at = ?, last_error = NULL WHERE batch_id = ?",
    ).run(JSON.stringify(body.receipts), ts, batchId);
  } catch (error) {
    const code = error instanceof EngineError ? error.code : "unknown_error";
    db.prepare("UPDATE command_batches SET last_error = ? WHERE batch_id = ?").run(`${code}:${error.message}`, batchId);
    if (code === "engine_rejected") {
      db.prepare("UPDATE command_batches SET status = 'failed' WHERE batch_id = ?").run(batchId);
    }
  }
  return db.prepare("SELECT * FROM command_batches WHERE batch_id = ?").get(batchId);
}

async function retryBatch(db, deps, batchId) {
  const batch = db.prepare("SELECT * FROM command_batches WHERE batch_id = ?").get(batchId);
  if (!batch) throw httpError(404, "batch_not_found");
  if (batch.status === "failed") throw httpError(409, "batch_failed", "批次被原执行节点拒绝，不得原样重试");
  return attemptBatch(db, deps, batchId);
}

// 临时放行：只作用于明确乘车人、明确渠道、明确时间窗
async function issueTempGrant(db, deps, actor, body) {
  const caseRow = getCase(db, body.case_ref);
  if (!caseRow) throw httpError(404, "case_not_found");
  if (caseRow.status === "merged") throw httpError(409, "case_merged", `案件已合并至 ${caseRow.merged_into}`);
  if (["closed", "resolved"].includes(caseRow.status)) {
    throw httpError(409, "invalid_status", "案件已进入终局阶段，不能再签发临时放行");
  }
  assertNoLink(db, caseRow, actor);
  const fact = JSON.parse(caseRow.fact_snapshot);
  if (body.passenger_token !== caseRow.passenger_token) {
    throw httpError(400, "passenger_mismatch", "临时放行必须明确乘车人，且只能是本案乘车人");
  }
  const channels = body.channels;
  if (!Array.isArray(channels) || channels.length === 0) throw httpError(400, "invalid_request", "需要明确渠道列表");
  for (const channel of channels) {
    if (!fact.restricted_channels.includes(channel)) {
      throw httpError(400, "channel_not_restricted", `渠道 ${channel} 当前不在限制范围`);
    }
  }
  const from = new Date(body.valid_from || nowIso());
  const until = new Date(body.valid_until);
  if (Number.isNaN(until.getTime())) throw httpError(400, "invalid_request", "valid_until 非法");
  if (until <= from) throw httpError(400, "invalid_window", "放行结束时间必须晚于开始时间");
  if (until.getTime() - from.getTime() > MAX_GRANT_HOURS * 3_600_000) {
    throw httpError(400, "window_too_long", `临时放行不得超过 ${MAX_GRANT_HOURS} 小时`);
  }

  const ts = nowIso();
  const grantResult = db.prepare(
    `INSERT INTO temp_grants
       (case_ref, passenger_token, channels, valid_from, valid_until, status, reason, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    body.case_ref,
    body.passenger_token,
    JSON.stringify(channels),
    from.toISOString(),
    until.toISOString(),
    body.reason || "审查期间临时放行",
    actor.id,
    ts,
  );
  const grantId = Number(grantResult.lastInsertRowid);
  recordEvent(db, body.case_ref, "temp_grant_requested", actor.id, {
    grant_id: grantId,
    channels,
    valid_until: until.toISOString(),
  }, ts);

  const commands = channels.map((channel) => ({
    channel,
    action: "release",
    release_expires_at: until.toISOString(),
  }));
  const batch = await dispatchBatch(db, deps, {
    caseRef: body.case_ref,
    decisionRef: caseRow.decision_ref,
    purpose: "temp_release",
    commands,
  });
  db.prepare("UPDATE temp_grants SET batch_id = ? WHERE grant_id = ?").run(batch.batch_id, grantId);
  if (batch.status === "acked") {
    db.prepare("UPDATE temp_grants SET status = 'active' WHERE grant_id = ?").run(grantId);
    recordEvent(db, body.case_ref, "temp_grant_active", "system", {
      grant_id: grantId,
      channels,
      valid_until: until.toISOString(),
    });
  }
  return {
    grant_id: grantId,
    status: batch.status === "acked" ? "active" : "pending_confirmation",
    valid_until: until.toISOString(),
    channels,
    batch_id: batch.batch_id,
    error: batch.last_error || undefined,
  };
}

// 到期自动回收：向原执行节点发送幂等 restrict 指令（引擎侧 TTL 同时兜底）
async function reclaimExpiredGrants(db, deps, now = nowIso()) {
  const due = db
    .prepare(
      `SELECT * FROM temp_grants
        WHERE status = 'active' AND valid_until <= ?`,
    )
    .all(now);
  const results = [];
  for (const grant of due) {
    const channels = JSON.parse(grant.channels);
    let batch;
    if (grant.reclaim_batch_id != null) {
      // 上一轮回收指令尚未确认：复用同一幂等批次重试，不重复建单
      batch = await retryBatch(db, deps, grant.reclaim_batch_id);
    } else {
      batch = await dispatchBatch(db, deps, {
        caseRef: grant.case_ref,
        decisionRef: getCase(db, grant.case_ref).decision_ref,
        purpose: "reclaim",
        commands: channels.map((channel) => ({ channel, action: "restrict" })),
      });
      db.prepare("UPDATE temp_grants SET reclaim_batch_id = ? WHERE grant_id = ?").run(batch.batch_id, grant.grant_id);
    }
    if (batch.status === "acked") {
      db.prepare("UPDATE temp_grants SET status = 'expired', finished_at = ? WHERE grant_id = ?").run(now, grant.grant_id);
      recordEvent(db, grant.case_ref, "temp_grant_expired", "system", {
        grant_id: grant.grant_id,
        channels,
        reclaimed_by: batch.batch_id,
      });
    }
    results.push({ grant_id: grant.grant_id, batch_id: batch.batch_id, status: batch.status });
  }
  return results;
}

module.exports = {
  CHANNELS,
  dispatchBatch,
  attemptBatch,
  retryBatch,
  issueTempGrant,
  reclaimExpiredGrants,
  addHours,
};
