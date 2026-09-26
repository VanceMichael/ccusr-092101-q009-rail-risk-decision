
const crypto = require("node:crypto");
const { checklistFor, CATALOG } = require("./catalog");
const { EngineError, fetchDecision } = require("./engineClient");

function nowIso() {
  return new Date().toISOString();
}

function addHours(iso, hours) {
  return new Date(new Date(iso).getTime() + hours * 3_600_000).toISOString();
}

function recordEvent(db, caseRef, type, actor, payload = {}, at = nowIso()) {
  db.prepare(
    "INSERT INTO case_events (case_ref, type, actor, at, payload) VALUES (?, ?, ?, ?, ?)",
  ).run(caseRef, type, actor, at, JSON.stringify(payload));
}

function newCaseRef() {
  return `C-${crypto.randomBytes(6).toString("hex")}`;
}

function newAccessToken() {
  return crypto.randomBytes(24).toString("hex");
}

function httpError(status, code, detail) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  error.detail = detail;
  return error;
}

// 受理：只接受外部风控决定的不可变引用；事实与原因类别以原执行节点公开视图为准
async function createCase(db, params) {
  const { actor, body, engineBaseUrl, engineToken, slaHours } = params;
  if (typeof body.decision_ref !== "string" || body.decision_ref.length === 0) {
    throw httpError(400, "invalid_request", "缺少 decision_ref");
  }
  if (typeof body.contact_token !== "string" || body.contact_token.length === 0) {
    throw httpError(400, "invalid_request", "缺少脱敏通知地址 contact_token");
  }

  let decision;
  try {
    decision = await fetchDecision(engineBaseUrl, body.decision_ref, engineToken);
  } catch (error) {
    if (error instanceof EngineError) throw httpError(502, "engine_unavailable", error.message);
    throw error;
  }
  if (!decision) throw httpError(404, "decision_not_found", "引用的风控决定不存在");

  const caseRef = newCaseRef();
  const accessToken = newAccessToken();
  const ts = nowIso();
  const restrictedChannels = decision.channels
    .filter((channel) => channel.state === "restricted")
    .map((channel) => channel.channel);

  const conflict = db
    .prepare("SELECT 1 FROM staff_links WHERE actor_id = ? AND account_token = ?")
    .get(actor.id, decision.account_token);

  // 重复案件：同一决定仍有未关闭案件，或同一乘车人针对同一原因仍有未关闭案件
  const priorOpen = db
    .prepare(
      `SELECT case_ref FROM cases
        WHERE passenger_token = ? AND status NOT IN ('closed','merged')
          AND (decision_ref = ? OR reason_public = ?)
        ORDER BY created_at LIMIT 1`,
    )
    .get(decision.passenger_token, body.decision_ref, decision.reason_public);

  const priorClosed = db
    .prepare(
      `SELECT case_ref, resolution FROM cases
        WHERE passenger_token = ? AND resolution IS NOT NULL
        ORDER BY adjudicated_at DESC LIMIT 1`,
    )
    .get(decision.passenger_token);

  db.exec("BEGIN IMMEDIATE");
  try {
    const status = priorOpen ? "merged" : "intake";
    db.prepare(
      `INSERT INTO cases
         (case_ref, access_token, decision_ref, account_token, passenger_token, reason_public,
          fact_snapshot, contact_token, status, intake_actor, conflict_flag,
          duplicate_of, merged_into, due_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      caseRef,
      accessToken,
      decision.decision_ref,
      decision.account_token,
      decision.passenger_token,
      decision.reason_public,
      JSON.stringify({
        decision_ref: decision.decision_ref,
        reason_public: decision.reason_public,
        reason_title: (CATALOG[decision.reason_public] || {}).title || decision.reason_public,
        decided_at: decision.decided_at,
        restricted_channels: restrictedChannels,
      }),
      body.contact_token,
      status,
      actor.id,
      conflict ? 1 : 0,
      priorOpen ? priorOpen.case_ref : null,
      priorOpen ? priorOpen.case_ref : null,
      priorOpen ? null : addHours(ts, slaHours.intake),
      ts,
      ts,
    );

    if (!priorOpen) {
      for (const item of checklistFor(decision.reason_public)) {
        db.prepare(
          `INSERT INTO checklist_items (case_ref, material_code, label, kind, scope, ordinal)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(caseRef, item.code, item.label, item.kind, JSON.stringify(item.scope), item.ordinal);
      }
    }

    recordEvent(db, caseRef, "created", actor.id, { reason_public: decision.reason_public }, ts);
    if (conflict) {
      recordEvent(db, caseRef, "conflict_flagged", "system", {
        reason: "self_related_account",
        account_token: decision.account_token,
        warned_to: actor.id,
      }, ts);
    }
    if (priorOpen) {
      recordEvent(db, caseRef, "merged", "system", { merged_into: priorOpen.case_ref }, ts);
      recordEvent(db, priorOpen.case_ref, "duplicate_linked", "system", { duplicate_case: caseRef }, ts);
    }
    if (priorClosed) {
      recordEvent(db, caseRef, "prior_case_linked", "system", {
        prior_case: priorClosed.case_ref,
        prior_resolution: priorClosed.resolution,
      }, ts);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    case_ref: caseRef,
    access_token: accessToken,
    status: priorOpen ? "merged" : "intake",
    warning: priorOpen
      ? `该申诉与进行中的案件 ${priorOpen.case_ref} 重复，已建立合并关系，无需重复提交材料`
      : conflict
        ? "利益冲突提示：该案件关联账号与受理人本人账号相关，已标记并将转交其他人员处理"
        : undefined,
    conflict: conflict ? "self_related_account" : undefined,
    merged_into: priorOpen ? priorOpen.case_ref : undefined,
    prior_case: priorClosed ? priorClosed.case_ref : undefined,
  };
}

function getCase(db, caseRef) {
  return db.prepare("SELECT * FROM cases WHERE case_ref = ?").get(caseRef);
}

// 旅客公开视图：只有可申诉事实、清单状态与进度，没有任何阈值或内部字段
function publicView(db, caseRef, accessToken) {
  const caseRow = getCase(db, caseRef);
  if (!caseRow) throw httpError(404, "case_not_found");
  if (caseRow.access_token !== accessToken) throw httpError(403, "invalid_access_token");

  const fact = JSON.parse(caseRow.fact_snapshot);
  const items = db
    .prepare("SELECT material_code, label, kind, ordinal, received_at FROM checklist_items WHERE case_ref = ? ORDER BY ordinal")
    .all(caseRef);
  const events = db
    .prepare("SELECT type, at, payload FROM case_events WHERE case_ref = ? ORDER BY seq")
    .all(caseRef);

  const VISIBLE = new Set([
    "created", "merged", "document_received", "supplement_requested", "resubmitted",
    "in_review", "temp_grant_active", "temp_grant_expired", "adjudicated", "closed",
    "prior_case_linked", "document_purged",
  ]);
  const timeline = events
    .filter((event) => VISIBLE.has(event.type))
    .map((event) => ({ type: event.type, at: event.at, detail: publicEvent(event) }));

  const view = {
    case_ref: caseRow.case_ref,
    status: caseRow.status,
    reason: { code: fact.reason_public, title: fact.reason_title },
    facts: {
      decision_ref: fact.decision_ref,
      decided_at: fact.decided_at,
      restricted_channels: fact.restricted_channels,
    },
    checklist: items.map((item) => ({
      material_code: item.material_code,
      label: item.label,
      kind: item.kind,
      received: item.received_at != null,
    })),
    timeline,
  };
  if (caseRow.status === "merged") view.merged_into = caseRow.merged_into;
  if (caseRow.resolution) {
    view.resolution = {
      outcome: caseRow.resolution,
      adjudicated_at: caseRow.adjudicated_at,
    };
  }
  return view;
}

function publicEvent(event) {
  const payload = JSON.parse(event.payload || "{}");
  switch (event.type) {
    case "supplement_requested":
      return { items: payload.items, reason: payload.reason };
    case "adjudicated":
      return { outcome: payload.decision, note: payload.public_note, release_channels: payload.release_channels };
    case "temp_grant_active":
      return { channels: payload.channels, valid_until: payload.valid_until };
    case "merged":
      return { merged_into: payload.merged_into };
    case "document_received":
      return { material_code: payload.material_code };
    default:
      return {};
  }
}

// 坐席工作台视图（仍不含阈值；内部字段仅限工作流需要的状态）
function staffView(db, caseRef, actor) {
  const caseRow = getCase(db, caseRef);
  if (!caseRow) throw httpError(404, "case_not_found");
  if (caseRow.status === "merged") {
    return { case_ref: caseRow.case_ref, status: "merged", merged_into: caseRow.merged_into };
  }
  const items = db
    .prepare("SELECT material_code, label, kind, scope, ordinal, document_id, received_at FROM checklist_items WHERE case_ref = ? ORDER BY ordinal")
    .all(caseRef);
  const documents = db
    .prepare(
      `SELECT document_id, material_code, kind, scope, retention_days, sha256, storage_ref,
              submitted_by, submitted_at, retention_until, purged_at
         FROM documents WHERE case_ref = ? ORDER BY document_id`,
    )
    .all(caseRef)
    .map((doc) => redactDocument(doc, actor.role));
  const grants = db
    .prepare("SELECT grant_id, channels, valid_from, valid_until, status FROM temp_grants WHERE case_ref = ? ORDER BY grant_id")
    .all(caseRef)
    .map((grant) => ({ ...grant, channels: JSON.parse(grant.channels) }));
  const review = db.prepare("SELECT actor, opinion, rationale, created_at FROM reviews WHERE case_ref = ?").get(caseRef);
  const adjudication = db
    .prepare("SELECT actor, decision, release_channels, rationale, created_at FROM adjudications WHERE case_ref = ?")
    .get(caseRef);
  return {
    case_ref: caseRow.case_ref,
    status: caseRow.status,
    resolution: caseRow.resolution,
    conflict_flag: caseRow.conflict_flag === 1,
    fact_snapshot: JSON.parse(caseRow.fact_snapshot),
    intake_actor: caseRow.intake_actor,
    review_actor: caseRow.review_actor,
    adjudicator: caseRow.adjudicator,
    due_at: caseRow.due_at,
    checklist: items.map((item) => ({ ...item, scope: JSON.parse(item.scope), received: item.received_at != null })),
    documents,
    grants,
    review: review ? { ...review, opinion: review.opinion } : null,
    adjudication: adjudication ? { ...adjudication, release_channels: JSON.parse(adjudication.release_channels) } : null,
  };
}

function redactDocument(doc, role) {
  const scope = JSON.parse(doc.scope);
  const allowed = scope.includes(role);
  const out = {
    document_id: doc.document_id,
    material_code: doc.material_code,
    kind: doc.kind,
    sha256: doc.sha256,
    submitted_at: doc.submitted_at,
    purged_at: doc.purged_at,
    access: allowed ? "full" : "metadata_only",
  };
  if (allowed && !doc.purged_at) out.storage_ref = doc.storage_ref;
  return out;
}

// 补件登记：只记录受控引用与摘要，不接触材料内容本身
function submitDocument(db, caseRef, actor, body) {
  const caseRow = assertActiveCase(db, caseRef);
  if (!["intake", "supplement_pending"].includes(caseRow.status)) {
    throw httpError(409, "invalid_status", `当前状态 ${caseRow.status} 不允许补件`);
  }
  assertNoLink(db, caseRow, actor);
  const item = db
    .prepare("SELECT * FROM checklist_items WHERE case_ref = ? AND material_code = ?")
    .get(caseRef, body.material_code);
  if (!item) throw httpError(404, "material_not_required", "该材料不在最少材料清单内");
  if (item.document_id != null) throw httpError(409, "already_received", "该材料已提交");
  if (typeof body.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.sha256)) {
    throw httpError(400, "invalid_request", "需要材料 sha256 摘要");
  }
  if (typeof body.storage_ref !== "string" || body.storage_ref.length === 0) {
    throw httpError(400, "invalid_request", "需要材料受控引用 storage_ref");
  }
  const scope = JSON.parse(item.scope);
  const retentionDays = retentionFor(body.material_code, item.kind);
  const ts = nowIso();

  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare(
      `INSERT INTO documents
         (case_ref, material_code, kind, scope, retention_days, sha256, storage_ref, submitted_by, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(caseRef, body.material_code, item.kind, JSON.stringify(scope), retentionDays, body.sha256, body.storage_ref, actor.id, ts);
    db.prepare("UPDATE checklist_items SET document_id = ?, received_at = ? WHERE case_ref = ? AND material_code = ?")
      .run(Number(result.lastInsertRowid), ts, caseRef, body.material_code);
    recordEvent(db, caseRef, "document_received", actor.id, {
      material_code: body.material_code,
      sha256: body.sha256,
    }, ts);
    db.prepare("UPDATE cases SET updated_at = ? WHERE case_ref = ?").run(ts, caseRef);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { ok: true, material_code: body.material_code };
}

function retentionFor(materialCode, kind) {
  for (const entry of Object.values(CATALOG)) {
    const found = entry.materials.find((material) => material.code === materialCode);
    if (found) return found.retentionDays;
  }
  return kind === "sensitive" ? 30 : 180;
}

// 读取敏感材料：按授权范围放行并留痕；越权访问被拒绝且记录
function accessDocument(db, caseRef, actor, documentId, purpose) {
  const doc = db.prepare("SELECT * FROM documents WHERE document_id = ? AND case_ref = ?").get(documentId, caseRef);
  if (!doc) throw httpError(404, "document_not_found");
  const scope = JSON.parse(doc.scope);
  const allowed = scope.includes(actor.role);
  db.prepare(
    "INSERT INTO document_access (document_id, actor_id, purpose, at, allowed) VALUES (?, ?, ?, ?, ?)",
  ).run(documentId, actor.id, purpose || "unspecified", nowIso(), allowed ? 1 : 0);
  if (!allowed) throw httpError(403, "out_of_scope", "该敏感材料不在当前角色授权范围内");
  if (doc.purged_at) throw httpError(410, "document_purged", "材料已过保留期被清除");
  return { document_id: doc.document_id, material_code: doc.material_code, storage_ref: doc.storage_ref, sha256: doc.sha256 };
}

function assertActiveCase(db, caseRef) {
  const caseRow = getCase(db, caseRef);
  if (!caseRow) throw httpError(404, "case_not_found");
  if (caseRow.status === "merged") throw httpError(409, "case_merged", `案件已合并至 ${caseRow.merged_into}`);
  if (caseRow.status === "closed") throw httpError(409, "case_closed", "案件已关闭");
  return caseRow;
}

// 实时利益冲突检查：任何环节，只要操作人与本案账号存在本人关联，一律回避
function assertNoLink(db, caseRow, actor) {
  const linked = db
    .prepare("SELECT 1 FROM staff_links WHERE actor_id = ? AND account_token = ?")
    .get(actor.id, caseRow.account_token);
  if (linked) {
    recordEvent(db, caseRow.case_ref, "conflict_access_denied", actor.id, { stage: caseRow.status });
    throw httpError(403, "conflict_of_interest", "本人关联账号案件，必须回避");
  }
}

module.exports = {
  nowIso,
  addHours,
  recordEvent,
  httpError,
  createCase,
  getCase,
  publicView,
  staffView,
  submitDocument,
  accessDocument,
  assertActiveCase,
  assertNoLink,
};
