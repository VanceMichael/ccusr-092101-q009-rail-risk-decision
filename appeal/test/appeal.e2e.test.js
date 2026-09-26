
const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");

const engineFactory = require("../../src/server");
const engineDbFactory = require("../../src/db");
const appealFactory = require("../src/server");
const appealDbFactory = require("../src/db");
const workflow = require("../src/workflow");

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

function sha() {
  return crypto.createHash("sha256").digest("hex");
}

async function harness(options = {}) {
  const engineDb = engineDbFactory.openDatabase(":memory:");
  const engine = engineFactory.createServer({ db: engineDb, serviceSecret: "st" });
  const enginePort = await listen(engine);

  const appealDb = appealDbFactory.openDatabase(":memory:");
  const appeal = appealFactory.createServer({
    db: appealDb,
    engineBaseUrl: `http://127.0.0.1:${enginePort}`,
    engineToken: "st",
    adminToken: "admin",
    notifierOptions: { mode: options.notifierMode || "fake" },
    slaHours: { intake: options.intakeSlaHours ?? 48 },
    background: false,
  });
  const appealPort = await listen(appeal);

  async function api(method, path, body, headers = {}) {
    const response = await fetch(`http://127.0.0.1:${appealPort}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  async function engineApi(method, path, body, headers = {}) {
    const response = await fetch(`http://127.0.0.1:${enginePort}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  async function seedDecision(ref, { passenger = "PAX-1", account = "ACC-1", channels = ["app", "web"] } = {}) {
    await engineApi("POST", "/internal/decisions", {
      decision_ref: ref,
      account_token: account,
      passenger_token: passenger,
      reason_public: "proxy_purchase_suspected",
      rule_revision: 99,
      decided_at: "2026-09-26T08:00:00+08:00",
      channels: channels.map((channel) => ({ channel, state: "restricted" })),
    });
  }
  async function stop() {
    await new Promise((resolve) => appeal.close(resolve));
    await new Promise((resolve) => engine.close(resolve));
  }
  return { api, engineApi, seedDecision, stop, appealDb, engineDb, appealPort };
}

const INTAKE = { "x-actor-id": "intake-1", "x-actor-role": "intake_agent" };
const INTAKE_2 = { "x-actor-id": "intake-2", "x-actor-role": "intake_agent" };
const REVIEWER = { "x-actor-id": "reviewer-1", "x-actor-role": "reviewer" };
const SUPERVISOR = { "x-actor-id": "super-1", "x-actor-role": "supervisor" };

async function submitAllMaterials(api, caseRef, actor) {
  for (const code of ["realname_passenger", "relationship_proof", "purchase_authorization"]) {
    const result = await api("POST", `/staff/cases/${caseRef}/documents`, { material_code: code, sha256: sha(), storage_ref: `store-${code}` }, actor);
    assert.equal(result.status, 201, `提交材料 ${code}: ${JSON.stringify(result.body)}`);
  }
}

async function fullUpholdFlow(api, decisionRef, { supervisor = SUPERVISOR, reviewer = REVIEWER, intake = INTAKE, grant = false } = {}) {
  const created = await api("POST", "/staff/cases", { decision_ref: decisionRef, contact_token: "TEL-x" }, intake);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const caseRef = created.body.case_ref;
  const accessToken = created.body.access_token;
  await submitAllMaterials(api, caseRef, intake);
  if (grant) {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const g = await api("POST", `/staff/cases/${caseRef}/temp-grants`, {
      passenger_token: "PAX-1", channels: ["app"], valid_until: until,
    }, supervisor);
    assert.equal(g.status, 202);
    assert.equal(g.body.status, "active");
  }
  const submitted = await api("POST", `/staff/cases/${caseRef}/submit-review`, {}, intake);
  assert.equal(submitted.status, 200);
  const review = await api("POST", `/staff/cases/${caseRef}/reviews`, {
    opinion: "suggest_overturn", rationale: "关系证明、购票授权与实名材料一致，属于子女为父母代购",
  }, reviewer);
  assert.equal(review.status, 201);
  const adj = await api("POST", `/staff/cases/${caseRef}/adjudications`, {
    decision: "overturn", rationale: "代购关系、支付授权与实名材料相互印证，原限制不成立",
  }, supervisor);
  assert.equal(adj.status, 201);
  assert.equal(adj.body.command_status, "acked");
  const closed = await api("POST", `/staff/cases/${caseRef}/close`, {}, supervisor);
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  return { caseRef, accessToken };
}

test("端到端：受理→补件→四眼复核→裁决撤销→对账关案，旅客只见事实与进度", async () => {
  const h = await harness();
  try {
    await h.seedDecision("RD-E2E-1");
    const { caseRef, accessToken } = await fullUpholdFlow(h.api, "RD-E2E-1", { grant: true });

    // 引擎侧各渠道确已解除
    const view = (await h.engineApi("GET", "/public/decisions/RD-E2E-1")).body;
    assert.deepEqual(view.channels.map((c) => [c.channel, c.state]), [["app", "released"], ["web", "released"]]);

    // 旅客公开视图：无阈值/规则版本，只有事实、清单与进度
    const pub = await h.api("GET", `/public/cases/${caseRef}`, null, { "x-access-token": accessToken });
    assert.equal(pub.status, 200);
    assert.equal(pub.body.status, "closed");
    assert.equal(pub.body.reason.code, "proxy_purchase_suspected");
    assert.equal(pub.body.facts.decision_ref, "RD-E2E-1");
    assert.equal("rule_revision" in pub.body, false);
    assert.equal(pub.body.checklist.length, 3);
    assert.ok(pub.body.checklist.every((item) => item.received));
    const types = pub.body.timeline.map((event) => event.type);
    assert.deepEqual(types, ["created", "document_received", "document_received", "document_received", "temp_grant_active", "in_review", "adjudicated", "closed"]);
    assert.equal(pub.body.resolution.outcome, "overturn");

    // 错令牌不可查
    assert.equal((await h.api("GET", `/public/cases/${caseRef}`, null, { "x-access-token": "wrong" })).status, 403);

    // 关案证据已固化在事件中（裁决与逐项回执不可抹除）
    const closedEvent = h.appealDb.prepare("SELECT payload FROM case_events WHERE type = 'closed'").get();
    const evidence = JSON.parse(closedEvent.payload).evidence;
    assert.equal(evidence.channel_etags.length, 2);
    assert.ok(evidence.notifications_sent.length >= 1);
  } finally {
    await h.stop();
  }
});

test("职责分离：受理人不能复核/裁决，裁决人不能受理/复核过本案", async () => {
  const h = await harness();
  try {
    await h.seedDecision("RD-SOD");
    const created = await h.api("POST", "/staff/cases", { decision_ref: "RD-SOD", contact_token: "TEL-x" }, INTAKE);
    const caseRef = created.body.case_ref;
    await submitAllMaterials(h.api, caseRef, INTAKE);

    // 受理人自己复核 → 拒绝
    assert.equal((await h.api("POST", `/staff/cases/${caseRef}/reviews`, {
      opinion: "suggest_overturn", rationale: "自己复核自己",
    }, INTAKE)).status, 403);

    // 未受理角色不能提交复核
    assert.equal((await h.api("POST", `/staff/cases/${caseRef}/submit-review`, {}, REVIEWER)).status, 403);

    await h.api("POST", `/staff/cases/${caseRef}/submit-review`, {}, INTAKE);
    await h.api("POST", `/staff/cases/${caseRef}/reviews`, {
      opinion: "suggest_overturn", rationale: "材料一致，建议撤销",
    }, REVIEWER);

    // 主管不能是受理人或复核人
    const adjIntake = await h.api("POST", `/staff/cases/${caseRef}/adjudications`, {
      decision: "overturn", rationale: "越权裁决",
    }, INTAKE);
    assert.equal(adjIntake.status, 403);
    const adjReviewer = await h.api("POST", `/staff/cases/${caseRef}/adjudications`, {
      decision: "overturn", rationale: "越权裁决",
    }, REVIEWER);
    assert.equal(adjReviewer.status, 403);

    // 复核完成但未裁决不能关案
    assert.equal((await h.api("POST", `/staff/cases/${caseRef}/close`, {}, SUPERVISOR)).status, 409);
  } finally {
    await h.stop();
  }
});

test("利益冲突：本人关联账号被标记并强制回避，由他人完成流程", async () => {
  const h = await harness();
  try {
    await h.seedDecision("RD-CONF");
    await h.api("POST", "/admin/staff-links", { actor_id: "intake-1", account_token: "ACC-1" }, { "x-admin-token": "admin" });

    const created = await h.api("POST", "/staff/cases", { decision_ref: "RD-CONF", contact_token: "TEL-x" }, INTAKE);
    assert.equal(created.status, 201);
    assert.equal(created.body.conflict, "self_related_account");
    const caseRef = created.body.case_ref;

    // 本人继续操作被拒
    const denied = await h.api("POST", `/staff/cases/${caseRef}/documents`,
      { material_code: "realname_passenger", sha256: sha(), storage_ref: "s" }, INTAKE);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, "conflict_of_interest");

    // 主管看板的利益冲突队列能按时发现
    const dash = await h.api("GET", "/supervisor/dashboard", null, SUPERVISOR);
    assert.ok(dash.body.conflict_queue.some((row) => row.case_ref === caseRef));

    // 回避：另一名受理人接续
    await submitAllMaterials(h.api, caseRef, INTAKE_2);
    await h.api("POST", `/staff/cases/${caseRef}/submit-review`, {}, INTAKE_2);
    await h.api("POST", `/staff/cases/${caseRef}/reviews`, {
      opinion: "suggest_maintain", rationale: "授权材料可信，记录在案",
    }, REVIEWER);
    const adj = await h.api("POST", `/staff/cases/${caseRef}/adjudications`, {
      decision: "maintain", rationale: "材料虽齐但不构成解除依据，维持并记录理由",
    }, SUPERVISOR);
    assert.equal(adj.status, 201);
    // 维持：引擎侧渠道仍为 restricted，与意图一致，可以关案
    const closed = await h.api("POST", `/staff/cases/${caseRef}/close`, {}, SUPERVISOR);
    assert.equal(closed.status, 200);
    const view = (await h.engineApi("GET", "/public/decisions/RD-CONF")).body;
    assert.ok(view.channels.every((channel) => channel.state === "restricted"));
  } finally {
    await h.stop();
  }
});

test("重复案件自动建立合并关系，合并案件不接受重复操作", async () => {
  const h = await harness();
  try {
    await h.seedDecision("RD-DUP");
    const first = await h.api("POST", "/staff/cases", { decision_ref: "RD-DUP", contact_token: "TEL-x" }, INTAKE);
    const firstRef = first.body.case_ref;
    const second = await h.api("POST", "/staff/cases", { decision_ref: "RD-DUP", contact_token: "TEL-x" }, INTAKE);
    assert.equal(second.status, 200);
    assert.equal(second.body.status, "merged");
    assert.equal(second.body.merged_into, firstRef);

    const dupDoc = await h.api("POST", `/staff/cases/${second.body.case_ref}/documents`,
      { material_code: "realname_passenger", sha256: sha(), storage_ref: "s" }, INTAKE);
    assert.equal(dupDoc.status, 409);
    assert.equal(dupDoc.body.error, "case_merged");

    // 原案件时间线记录了重复关系
    const staff = await h.api("GET", `/staff/cases/${firstRef}`, null, INTAKE);
    assert.equal(staff.body.status, "intake");
  } finally {
    await h.stop();
  }
});

test("敏感材料按授权范围隔离：受理只见摘要，复核可见内容，越权访问留痕", async () => {
  const h = await harness();
  try {
    await h.seedDecision("RD-SCOPE");
    const created = await h.api("POST", "/staff/cases", { decision_ref: "RD-SCOPE", contact_token: "TEL-x" }, INTAKE);
    const caseRef = created.body.case_ref;
    await h.api("POST", `/staff/cases/${caseRef}/documents`,
      { material_code: "relationship_proof", sha256: sha(), storage_ref: "secret-store-1" }, INTAKE);

    const staffIntake = (await h.api("GET", `/staff/cases/${caseRef}`, null, INTAKE)).body;
    const sensitive = staffIntake.documents.find((doc) => doc.material_code === "relationship_proof");
    assert.equal(sensitive.access, "metadata_only");
    assert.equal("storage_ref" in sensitive, false);

    const docId = sensitive.document_id;
    const denied = await h.api("POST", `/staff/cases/${caseRef}/document-access`, { document_id: docId, purpose: "查看" }, INTAKE);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, "out_of_scope");

    // 进入复核后，复核人在授权范围内可取用受控引用
    await h.api("POST", `/staff/cases/${caseRef}/documents`,
      { material_code: "realname_passenger", sha256: sha(), storage_ref: "s2" }, INTAKE);
    await h.api("POST", `/staff/cases/${caseRef}/documents`,
      { material_code: "purchase_authorization", sha256: sha(), storage_ref: "s3" }, INTAKE);
    await h.api("POST", `/staff/cases/${caseRef}/submit-review`, {}, INTAKE);
    const granted = await h.api("POST", `/staff/cases/${caseRef}/document-access`, { document_id: docId, purpose: "复核亲属关系" }, REVIEWER);
    assert.equal(granted.status, 200);
    assert.equal(granted.body.storage_ref, "secret-store-1");

    const logs = h.appealDb.prepare("SELECT allowed FROM document_access WHERE document_id = ? ORDER BY rowid").all(docId);
    assert.deepEqual(logs.map((row) => row.allowed), [0, 1]);
  } finally {
    await h.stop();
  }
});

test("临时放行限定乘车人/渠道/时间窗，到期自动回收", async () => {
  const h = await harness();
  try {
    await h.seedDecision("RD-GRANT");
    const created = await h.api("POST", "/staff/cases", { decision_ref: "RD-GRANT", contact_token: "TEL-x" }, INTAKE);
    const caseRef = created.body.case_ref;

    const wrongPassenger = await h.api("POST", `/staff/cases/${caseRef}/temp-grants`, {
      passenger_token: "PAX-OTHER", channels: ["app"], valid_until: new Date(Date.now() + 3_600_000).toISOString(),
    }, SUPERVISOR);
    assert.equal(wrongPassenger.status, 400);

    const notRestricted = await h.api("POST", `/staff/cases/${caseRef}/temp-grants`, {
      passenger_token: "PAX-1", channels: ["app", "agent_terminal"], valid_until: new Date(Date.now() + 3_600_000).toISOString(),
    }, SUPERVISOR);
    assert.equal(notRestricted.status, 400);

    const grant = await h.api("POST", `/staff/cases/${caseRef}/temp-grants`, {
      passenger_token: "PAX-1", channels: ["app"], valid_until: new Date(Date.now() + 3_600_000).toISOString(),
    }, SUPERVISOR);
    assert.equal(grant.status, 202);
    let view = (await h.engineApi("GET", "/public/decisions/RD-GRANT")).body;
    assert.equal(view.channels.find((c) => c.channel === "app").state, "released");
    assert.equal(view.channels.find((c) => c.channel === "web").state, "restricted");

    // 将放行到期时间拨到过去，触发 sweep：申诉侧发出回收指令，引擎侧渠道恢复 restricted
    h.appealDb.prepare("UPDATE temp_grants SET valid_until = ? WHERE status = 'active'").run("2026-09-20T00:00:00Z");
    h.engineDb.prepare("UPDATE channel_restrictions SET release_expires_at = ? WHERE decision_ref = 'RD-GRANT' AND channel = 'app'")
      .run("2026-09-20T00:00:00Z");
    const sweep = await h.api("POST", "/internal/sweep", null, { "x-admin-token": "admin" });
    assert.equal(sweep.status, 200);
    assert.equal(sweep.body.reclaimed[0].status, "acked");

    const after = (await h.engineApi("GET", "/public/decisions/RD-GRANT")).body;
    assert.equal(after.channels.find((c) => c.channel === "app").state, "restricted");
    const grantRow = h.appealDb.prepare("SELECT status FROM temp_grants").get();
    assert.equal(grantRow.status, "expired");

    // 再次 sweep 不应重复建单：回收批次幂等复用
    const sweepAgain = await h.api("POST", "/internal/sweep", null, { "x-admin-token": "admin" });
    assert.deepEqual(sweepAgain.body.reclaimed, []);
  } finally {
    await h.stop();
  }
});

test("网络重试复用幂等键：回执重放，渠道状态不被重复变更", async () => {
  const h = await harness();
  try {
    await h.seedDecision("RD-RETRY");
    const created = await h.api("POST", "/staff/cases", { decision_ref: "RD-RETRY", contact_token: "TEL-x" }, INTAKE);
    const caseRef = created.body.case_ref;
    const grant = await h.api("POST", `/staff/cases/${caseRef}/temp-grants`, {
      passenger_token: "PAX-1", channels: ["app"], valid_until: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    }, SUPERVISOR);
    const batchId = grant.body.batch_id;

    const before = (await h.engineApi("GET", "/public/decisions/RD-RETRY")).body.channels.find((c) => c.channel === "app").etag;
    const retried = await h.api("POST", `/staff/batches/${batchId}/retry`, {}, INTAKE);
    assert.equal(retried.status, 200);
    assert.equal(retried.body.status, "acked");
    const after = (await h.engineApi("GET", "/public/decisions/RD-RETRY")).body.channels.find((c) => c.channel === "app").etag;
    assert.equal(after, before); // 重试没有产生第二次状态变更
  } finally {
    await h.stop();
  }
});

test("关案闸门：通知未送达时拒绝关闭，重试送达后一致关案", async () => {
  const h = await harness({ notifierMode: "fail_once" });
  try {
    await h.seedDecision("RD-GATE");
    const created = await h.api("POST", "/staff/cases", { decision_ref: "RD-GATE", contact_token: "TEL-x" }, INTAKE);
    const caseRef = created.body.case_ref;
    await submitAllMaterials(h.api, caseRef, INTAKE);
    await h.api("POST", `/staff/cases/${caseRef}/submit-review`, {}, INTAKE);
    await h.api("POST", `/staff/cases/${caseRef}/reviews`, {
      opinion: "suggest_narrow", rationale: "网页渠道为父母常用，建议仅解除网页渠道", suggested_channels: ["web"],
    }, REVIEWER);
    const adj = await h.api("POST", `/staff/cases/${caseRef}/adjudications`, {
      decision: "narrow", release_channels: ["web"], rationale: "网页渠道为父母常用，解除网页，保留 App 限制观察",
    }, SUPERVISOR);
    assert.equal(adj.status, 201);
    assert.equal(adj.body.notification_status, "failed");

    const blocked = await h.api("POST", `/staff/cases/${caseRef}/close`, {}, SUPERVISOR);
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.detail, /通知/);

    const noticeId = adj.body.notification_id;
    const retried = await h.api("POST", `/staff/notifications/${noticeId}/retry`, {}, INTAKE);
    assert.equal(retried.body.status, "sent");

    const closed = await h.api("POST", `/staff/cases/${caseRef}/close`, {}, SUPERVISOR);
    assert.equal(closed.status, 200);
    const view = (await h.engineApi("GET", "/public/decisions/RD-GATE")).body;
    assert.equal(view.channels.find((c) => c.channel === "app").state, "restricted");
    assert.equal(view.channels.find((c) => c.channel === "web").state, "released");
  } finally {
    await h.stop();
  }
});

test("保留期：关案后到期清除敏感材料受控引用，摘要锚点保留且内容不可再访问", async () => {
  const h = await harness();
  try {
    await h.seedDecision("RD-RET");
    const { caseRef } = await fullUpholdFlow(h.api, "RD-RET");
    const doc = h.appealDb.prepare("SELECT * FROM documents WHERE material_code = 'relationship_proof'").get();
    assert.ok(doc.retention_until != null);
    assert.equal(doc.retention_days, 30);

    const purged = workflow.purgeExpiredDocuments(h.appealDb, "2030-01-01T00:00:00Z");
    assert.ok(purged.includes(doc.document_id));
    const after = h.appealDb.prepare("SELECT * FROM documents WHERE document_id = ?").get(doc.document_id);
    assert.equal(after.storage_ref, null);
    assert.ok(after.sha256.length === 64); // 摘要锚点保留
    assert.ok(after.purged_at != null);
  } finally {
    await h.stop();
  }
});

test("不可变性：事件、复核、裁决禁止修改或删除", async () => {
  const h = await harness();
  try {
    await h.seedDecision("RD-IMM");
    await fullUpholdFlow(h.api, "RD-IMM");
    assert.throws(() => h.appealDb.exec("UPDATE case_events SET type = 'x'"));
    assert.throws(() => h.appealDb.exec("DELETE FROM case_events"));
    assert.throws(() => h.appealDb.exec("UPDATE adjudications SET decision = 'maintain'"));
    assert.throws(() => h.appealDb.exec("DELETE FROM reviews"));
  } finally {
    await h.stop();
  }
});

test("主管看板：时限积压可见；同一乘车人两次申诉成立被识别为反复误伤，且历史结论不被新案件抹除", async () => {
  const h = await harness({ intakeSlaHours: -1 });
  try {
    await h.seedDecision("RD-RPT-1");
    const first = await fullUpholdFlow(h.api, "RD-RPT-1");

    // 再犯：产生新决定、新申诉；先前成立的结论仍可查
    await h.seedDecision("RD-RPT-2");
    const second = await fullUpholdFlow(h.api, "RD-RPT-2");
    const oldCase = h.appealDb.prepare("SELECT resolution, adjudicated_at FROM cases WHERE case_ref = ?").get(first.caseRef);
    assert.equal(oldCase.resolution, "overturn");
    assert.ok(oldCase.adjudicated_at);

    // 一个逾期未受理案件
    await h.seedDecision("RD-RPT-3");
    await h.api("POST", "/staff/cases", { decision_ref: "RD-RPT-3", contact_token: "TEL-y" }, INTAKE);

    const dash = await h.api("GET", "/supervisor/dashboard", null, SUPERVISOR);
    assert.equal(dash.status, 200);
    const repeat = dash.body.repeat_false_positives.find((row) => row.passenger_token === "PAX-1");
    assert.ok(repeat);
    assert.equal(repeat.upheld_appeals, 2);
    assert.deepEqual(repeat.case_refs.sort(), [first.caseRef, second.caseRef].sort());
    assert.ok(dash.body.overdue.some((row) => row.case_ref !== first.caseRef && row.case_ref !== second.caseRef));
  } finally {
    await h.stop();
  }
});
