
const CHANNELS = ["app", "web", "window", "agent_terminal"];
const ACTIONS = ["maintain", "release", "restrict"];

function nowIso() {
  return new Date().toISOString();
}

function effectiveState(row, now = nowIso()) {
  if (row.state === "released" && (row.release_expires_at == null || row.release_expires_at > now)) {
    return "released";
  }
  return "restricted";
}

// 将已到期的临时放行物理回收为 restricted；即使申诉侧回收指令延迟，渠道有效状态也不会继续放行
function reclaimExpired(db, now = nowIso()) {
  db.prepare(
    `UPDATE channel_restrictions
       SET state = 'restricted', release_expires_at = NULL, etag = etag + 1, updated_at = ?
     WHERE state = 'released' AND release_expires_at IS NOT NULL AND release_expires_at <= ?`,
  ).run(now, now);
}

function publicDecision(db, decisionRef, now = nowIso()) {
  reclaimExpired(db, now);
  const decision = db
    .prepare(
      `SELECT decision_ref, account_token, passenger_token, reason_public, decided_at
         FROM risk_decisions WHERE decision_ref = ?`,
    )
    .get(decisionRef);
  if (!decision) return null;
  const channels = db
    .prepare(
      `SELECT channel, state, release_expires_at, etag, updated_at
         FROM channel_restrictions WHERE decision_ref = ? ORDER BY channel`,
    )
    .all(decisionRef)
    .map((row) => ({
      channel: row.channel,
      state: effectiveState(row, now),
      release_expires_at: row.release_expires_at,
      etag: row.etag,
    }));
  return { ...decision, channels };
}

function ingestDecision(db, body) {
  const required = ["decision_ref", "account_token", "passenger_token", "reason_public", "decided_at"];
  for (const field of required) {
    if (typeof body[field] !== "string" || body[field].length === 0) {
      return { error: "invalid_request", detail: `缺少字段：${field}` };
    }
  }
  if (!Number.isInteger(body.rule_revision)) return { error: "invalid_request", detail: "rule_revision 必须为整数" };
  const channels = Array.isArray(body.channels) ? body.channels : [];
  if (channels.length === 0) return { error: "invalid_request", detail: "至少包含一个受限渠道" };
  for (const item of channels) {
    if (!CHANNELS.includes(item.channel) || (item.state !== "restricted" && item.state !== "released")) {
      return { error: "invalid_request", detail: `非法渠道状态：${JSON.stringify(item)}` };
    }
  }
  const ts = nowIso();
  try {
    db.prepare(
      `INSERT INTO risk_decisions
         (decision_ref, account_token, passenger_token, reason_public, rule_revision, decided_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      body.decision_ref,
      body.account_token,
      body.passenger_token,
      body.reason_public,
      body.rule_revision,
      body.decided_at,
      ts,
    );
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) return { error: "decision_exists", status: 409 };
    throw error;
  }
  const insertChannel = db.prepare(
    `INSERT INTO channel_restrictions (decision_ref, channel, state, etag, updated_at)
     VALUES (?, ?, ?, 0, ?)`,
  );
  for (const item of channels) insertChannel.run(body.decision_ref, item.channel, item.state, ts);
  return { ok: true };
}

// 执行一个指令批次；同一幂等键的重试不重复变更状态，首次逐项回执原样重放
function applyCommands(db, params) {
  const { idempotencyKey, caseRef, decisionRef, commands } = params;
  const existing = db
    .prepare("SELECT receipts_json, commands_hash FROM command_batches WHERE idempotency_key = ?")
    .get(idempotencyKey);
  if (existing) {
    if (existing.commands_hash !== fingerprint(caseRef, decisionRef, commands)) {
      return { status: 409, error: "idempotency_key_conflict" };
    }
    db.prepare("UPDATE command_batches SET repeated_at = ? WHERE idempotency_key = ?").run(
      nowIso(),
      idempotencyKey,
    );
    return { replayed: true, receipts: JSON.parse(existing.receipts_json) };
  }

  const decision = db.prepare("SELECT 1 FROM risk_decisions WHERE decision_ref = ?").get(decisionRef);
  if (!decision) return { status: 404, error: "decision_not_found" };

  const receipts = [];
  const ts = nowIso();
  const select = db.prepare(
    `SELECT state, release_expires_at, etag FROM channel_restrictions
      WHERE decision_ref = ? AND channel = ?`,
  );

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const command of commands) {
      if (!ACTIONS.includes(command.action)) {
        receipts.push({ channel: command.channel ?? null, accepted: false, error: "unknown_action" });
        continue;
      }
      const row = select.get(decisionRef, command.channel);
      if (!row) {
        receipts.push({ channel: command.channel, accepted: false, error: "channel_not_restricted" });
        continue;
      }
      let { state, release_expires_at: expiresAt, etag } = row;
      if (command.action === "release") {
        state = "released";
        expiresAt = command.release_expires_at ?? null;
      } else if (command.action === "restrict") {
        state = "restricted";
        expiresAt = null;
      }
      // maintain：保持现状
      db.prepare(
        `UPDATE channel_restrictions
           SET state = ?, release_expires_at = ?, etag = etag + 1, updated_at = ?
         WHERE decision_ref = ? AND channel = ?`,
      ).run(state, expiresAt, ts, decisionRef, command.channel);
      etag += 1;
      receipts.push({
        channel: command.channel,
        action: command.action,
        accepted: true,
        state_after: effectiveState({ state, release_expires_at: expiresAt }, ts),
        release_expires_at: expiresAt,
        etag_after: etag,
      });
    }
    db.prepare(
      `INSERT INTO command_batches (idempotency_key, case_ref, decision_ref, receipts_json, commands_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      idempotencyKey,
      caseRef,
      decisionRef,
      JSON.stringify(receipts),
      fingerprint(caseRef, decisionRef, commands),
      ts,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { replayed: false, receipts };
}

function fingerprint(caseRef, decisionRef, commands) {
  return `${caseRef}|${decisionRef}|${JSON.stringify(commands)}`;
}

module.exports = { CHANNELS, ACTIONS, nowIso, effectiveState, reclaimExpired, publicDecision, ingestDecision, applyCommands };
