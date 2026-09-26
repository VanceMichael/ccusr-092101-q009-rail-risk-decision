"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createServer } = require("../src/server");

const HOUR = 3600 * 1000;

async function makeApp(context) {
  let nowMs = Date.parse("2026-09-26T08:00:00+08:00");
  const server = createServer({
    databasePath: ":memory:",
    now: () => new Date(nowMs).toISOString(),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, { actor, body } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(actor ? { "x-actor-id": actor } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { api, advance: (ms) => { nowMs += ms; } };
}

async function seedStaff(api) {
  for (const [actor_id, role, linked] of [
    ["IN-1", "intake_officer", []],
    ["IN-SELF", "intake_officer", ["ACCOUNT-A"]],
    ["RV-1", "reviewer", []],
    ["AD-1", "adjudicator", []],
    ["SV-1", "supervisor", []],
  ]) {
    const res = await api("POST", "/staff", { body: { actor_id, role, linked_account_tokens: linked } });
    assert.equal(res.status, 201);
  }
}

function decision(ref, seq, extra = {}) {
  return {
    decision_ref: ref,
    source: "risk-engine",
    source_seq: seq,
    account_token: "ACCOUNT-A",
    passenger_token: "PAX-1",
    payer_token: "PAYER-1",
    device_token: "DEV-1",
    public_reason_category: "proxy_purchase_family",
    restriction_scope: { nodes: ["web", "app"] },
    rule_revision: 5,
    decided_at: "2026-09-26T07:00:00+08:00",
    ...extra,
  };
}

async function openCase(api, ref, seq) {
  await api("POST", "/risk-decisions", { body: decision(ref, seq) });
  const res = await api("POST", "/appeals", {
    body: { decision_ref: ref, appellant_token: "APPELLANT-1" },
  });
  assert.equal(res.status, 201);
  return res.body.case_id;
}

async function toAdjudicated(api, caseId, outcome = "revoke", extra = {}) {
  assert.equal((await api("POST", `/appeals/${caseId}/transitions`, { actor: "IN-1", body: { action: "accept" } })).status, 200);
  assert.equal((await api("POST", `/appeals/${caseId}/transitions`, { actor: "RV-1", body: { action: "review" } })).status, 200);
  const res = await api("POST", `/appeals/${caseId}/transitions`, {
    actor: "AD-1",
    body: { action: "adjudicate", outcome, rationale: "关系与支付材料核实一致", ...extra },
  });
  assert.equal(res.status, 200);
  return res.body;
}

async function settleCommands(api, caseId) {
  await api("POST", "/commands/dispatch", { actor: "AD-1" });
  const view = await api("GET", `/appeals/${caseId}`, { actor: "AD-1" });
  for (const command of view.body.commands) {
    if (command.status === "completed") continue;
    for (const node of command.scope.nodes) {
      const res = await api("POST", `/commands/${encodeURIComponent(command.command_id)}/receipts`, {
        body: { node_id: node, result: "applied" },
      });
      assert.equal(res.status, 200);
    }
  }
}

test("风控决定引用幂等接入且内容不可变", async (context) => {
  const { api } = await makeApp(context);
  const first = await api("POST", "/risk-decisions", { body: decision("D-1", "S-1") });
  assert.equal(first.status, 201);
  assert.equal(first.body.deduplicated, false);

  const again = await api("POST", "/risk-decisions", { body: decision("D-1", "S-1") });
  assert.equal(again.status, 200);
  assert.equal(again.body.deduplicated, true);

  const changed = await api("POST", "/risk-decisions", {
    body: decision("D-1", "S-1", { rule_revision: 6 }),
  });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, "immutable_conflict");

  const reusedSeq = await api("POST", "/risk-decisions", { body: decision("D-2", "S-1") });
  assert.equal(reusedSeq.status, 409);

  const badCategory = await api("POST", "/risk-decisions", {
    body: decision("D-3", "S-3", { public_reason_category: "secret_threshold_7" }),
  });
  assert.equal(badCategory.status, 400);
});

test("立案生成最少材料清单，重复案件提示合并", async (context) => {
  const { api } = await makeApp(context);
  await seedStaff(api);
  await api("POST", "/risk-decisions", { body: decision("D-1", "S-1") });
  const opened = await api("POST", "/appeals", {
    body: { decision_ref: "D-1", appellant_token: "APPELLANT-1" },
  });
  assert.equal(opened.status, 201);
  assert.deepEqual(opened.body.checklist, [
    "relationship_proof",
    "passenger_realname",
    "payment_record",
  ]);

  const duplicate = await api("POST", "/appeals", {
    body: { decision_ref: "D-1", appellant_token: "APPELLANT-1" },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, "duplicate_case");
  assert.equal(duplicate.body.details.existing_case_id, opened.body.case_id);

  // 同一旅客同一账号的其他在办案件给出合并提示
  await api("POST", "/risk-decisions", { body: decision("D-2", "S-2") });
  const second = await api("POST", "/appeals", {
    body: { decision_ref: "D-2", appellant_token: "APPELLANT-1" },
  });
  assert.equal(second.status, 201);
  assert.deepEqual(second.body.merge_hints, [opened.body.case_id]);

  // 合并后原案件不可再操作
  const merged = await api("POST", `/appeals/${second.body.case_id}/merge`, {
    actor: "IN-1",
    body: { into_case_id: opened.body.case_id },
  });
  assert.equal(merged.status, 200);
  assert.equal(merged.body.status, "merged");
});

test("受理、复核、裁决由相互制约的角色完成，关联账号必须回避", async (context) => {
  const { api } = await makeApp(context);
  await seedStaff(api);
  const caseId = await openCase(api, "D-1", "S-1");

  // 本人关联账号 → 利益冲突
  const conflict = await api("POST", `/appeals/${caseId}/transitions`, {
    actor: "IN-SELF",
    body: { action: "accept" },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, "conflict_of_interest");

  // 角色不符
  const wrongRole = await api("POST", `/appeals/${caseId}/transitions`, {
    actor: "RV-1",
    body: { action: "accept" },
  });
  assert.equal(wrongRole.status, 403);

  assert.equal((await api("POST", `/appeals/${caseId}/transitions`, { actor: "IN-1", body: { action: "accept" } })).status, 200);

  // 同一处理人不得跨阶段
  const crossStage = await api("POST", `/appeals/${caseId}/transitions`, {
    actor: "IN-1",
    body: { action: "review" },
  });
  assert.equal(crossStage.status, 409);
  assert.equal(crossStage.body.error, "separation_of_duties");

  assert.equal((await api("POST", `/appeals/${caseId}/transitions`, { actor: "RV-1", body: { action: "review" } })).status, 200);

  const crossStage2 = await api("POST", `/appeals/${caseId}/transitions`, {
    actor: "RV-1",
    body: { action: "adjudicate", outcome: "revoke", rationale: "x" },
  });
  assert.equal(crossStage2.status, 409);
  assert.equal(crossStage2.body.error, "separation_of_duties");

  // 裁决必须记录理由
  const noRationale = await api("POST", `/appeals/${caseId}/transitions`, {
    actor: "AD-1",
    body: { action: "adjudicate", outcome: "revoke" },
  });
  assert.equal(noRationale.status, 400);

  const done = await api("POST", `/appeals/${caseId}/transitions`, {
    actor: "AD-1",
    body: { action: "adjudicate", outcome: "revoke", rationale: "亲属关系与支付记录核实一致" },
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.status, "executing");
});

test("裁决指令幂等下发、逐项回执、重试不重复变更，关闭前一致性证明", async (context) => {
  const { api } = await makeApp(context);
  await seedStaff(api);
  const caseId = await openCase(api, "D-1", "S-1");
  await toAdjudicated(api, caseId, "revoke");

  // 未全部回执前禁止关闭
  const earlyClose = await api("POST", `/appeals/${caseId}/close`, { actor: "AD-1" });
  assert.equal(earlyClose.status, 422);
  assert.equal(earlyClose.body.error, "inconsistent_state");
  assert.deepEqual(earlyClose.body.details.incomplete_commands, [`${caseId}:adj`]);

  // 重复下发不新增指令
  await api("POST", "/commands/dispatch", { actor: "AD-1" });
  await api("POST", "/commands/dispatch", { actor: "AD-1" });
  let view = await api("GET", `/appeals/${caseId}`, { actor: "AD-1" });
  assert.equal(view.body.commands.length, 1);
  assert.equal(view.body.commands[0].status, "sent");

  // 逐项回执，重复回执去重
  const cmdId = encodeURIComponent(`${caseId}:adj`);
  const r1 = await api("POST", `/commands/${cmdId}/receipts`, { body: { node_id: "web", result: "applied" } });
  assert.equal(r1.body.deduplicated, false);
  const r1dup = await api("POST", `/commands/${cmdId}/receipts`, { body: { node_id: "web", result: "applied" } });
  assert.equal(r1dup.body.deduplicated, true);
  view = await api("GET", `/appeals/${caseId}`, { actor: "AD-1" });
  assert.equal(view.body.commands[0].status, "sent"); // 尚缺 app 回执

  await api("POST", `/commands/${cmdId}/receipts`, { body: { node_id: "app", result: "applied" } });
  view = await api("GET", `/appeals/${caseId}`, { actor: "AD-1" });
  assert.equal(view.body.commands[0].status, "completed");

  // 范围外节点的回执被拒绝
  const badNode = await api("POST", `/commands/${cmdId}/receipts`, { body: { node_id: "window", result: "applied" } });
  assert.equal(badNode.status, 400);

  // 一致性达成后关闭，并留下证明
  const closed = await api("POST", `/appeals/${caseId}/close`, { actor: "SV-1" });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.closure_check.consistent, true);
  view = await api("GET", `/appeals/${caseId}`, { actor: "SV-1" });
  assert.equal(view.body.case.status, "closed");
  assert.ok(view.body.closure_check);
});

test("临时放行限定乘车人/时间/渠道，到期自动回收并生成回收指令", async (context) => {
  const { api, advance } = await makeApp(context);
  await seedStaff(api);
  const caseId = await openCase(api, "D-1", "S-1");
  await api("POST", `/appeals/${caseId}/transitions`, { actor: "IN-1", body: { action: "accept" } });

  const release = await api("POST", `/appeals/${caseId}/temp-releases`, {
    actor: "IN-1",
    body: {
      passenger_token: "PAX-1",
      channel: "web",
      valid_from: "2026-09-26T08:00:00+08:00",
      valid_until: "2026-09-26T10:00:00+08:00",
    },
  });
  assert.equal(release.status, 201);
  assert.equal(release.body.status, "active");

  // 已过期的时间窗不可创建
  const invalid = await api("POST", `/appeals/${caseId}/temp-releases`, {
    actor: "IN-1",
    body: {
      passenger_token: "PAX-1",
      channel: "web",
      valid_from: "2026-09-26T08:00:00+08:00",
      valid_until: "2026-09-26T09:00:00+08:00",
    },
  });
  advance(3 * HOUR);
  const expired = await api("POST", `/appeals/${caseId}/temp-releases`, {
    actor: "IN-1",
    body: {
      passenger_token: "PAX-1",
      channel: "web",
      valid_from: "2026-09-26T08:00:00+08:00",
      valid_until: "2026-09-26T09:00:00+08:00",
    },
  });
  assert.equal(invalid.status, 201); // 创建时尚未到期
  assert.equal(expired.status, 400);

  // 到期后任意请求触发自动回收
  const view = await api("GET", `/appeals/${caseId}`, { actor: "AD-1" });
  const releases = view.body.temp_releases;
  assert.equal(releases[0].status, "expired");
  const expireCommands = view.body.commands.filter((c) => c.effect === "temp_release_expire");
  assert.equal(expireCommands.length, releases.length);
  assert.deepEqual(expireCommands[0].scope.nodes, ["web"]);
});

test("敏感证明按授权范围隔离、按保留期限清除", async (context) => {
  const { api, advance } = await makeApp(context);
  await seedStaff(api);
  const caseId = await openCase(api, "D-1", "S-1");

  const submitted = await api("POST", `/appeals/${caseId}/evidence`, {
    actor: "IN-1",
    body: {
      kind: "relationship_proof",
      storage_ref: "sha256:" + "a".repeat(64),
      scope: "adjudication",
      retention_until: "2026-09-26T09:00:00+08:00",
      submitted_by: "APPELLANT-1",
    },
  });
  assert.equal(submitted.status, 201);

  // 受理角色看不到 adjudication 级证明
  const intakeView = await api("GET", `/appeals/${caseId}/evidence`, { actor: "IN-1" });
  assert.equal(intakeView.body.evidence.length, 0);
  const adjudicatorView = await api("GET", `/appeals/${caseId}/evidence`, { actor: "AD-1" });
  assert.equal(adjudicatorView.body.evidence.length, 1);

  // 过保留期后引用被清除
  advance(2 * HOUR);
  const purged = await api("GET", `/appeals/${caseId}/evidence`, { actor: "AD-1" });
  assert.equal(purged.body.evidence[0].purged, true);
  assert.equal(purged.body.evidence[0].storage_ref, null);
});

test("旅客视图只含可申诉事实与进度，不含模型阈值", async (context) => {
  const { api } = await makeApp(context);
  await seedStaff(api);
  const caseId = await openCase(api, "D-1", "S-1");
  await toAdjudicated(api, caseId, "revoke");
  await settleCommands(api, caseId);
  await api("POST", `/appeals/${caseId}/close`, { actor: "AD-1" });

  const denied = await api("GET", `/passenger/cases/${caseId}?appellant_token=STRANGER`);
  assert.equal(denied.status, 404);

  const view = await api("GET", `/passenger/cases/${caseId}?appellant_token=APPELLANT-1`);
  assert.equal(view.status, 200);
  assert.equal(view.body.status, "closed");
  assert.equal(view.body.public_reason_category, "proxy_purchase_family");
  assert.equal(view.body.adjudication.outcome, "revoke");
  assert.ok(view.body.progress.some((e) => e.event_type === "adjudicated"));
  const serialized = JSON.stringify(view.body);
  assert.ok(!serialized.includes("rule_revision"));
  assert.ok(!serialized.includes("DEV-1"));
  assert.ok(!serialized.includes("AD-1"));
});

test("主管按时限发现积压与反复误伤；再犯不抹去先前申诉成立原因", async (context) => {
  const { api, advance } = await makeApp(context);
  await seedStaff(api);

  // 两次限制、两次申诉成立 → 反复误伤
  const case1 = await openCase(api, "D-1", "S-1");
  await toAdjudicated(api, case1, "revoke");
  await settleCommands(api, case1);
  await api("POST", `/appeals/${case1}/close`, { actor: "AD-1" });

  const case2 = await openCase(api, "D-2", "S-2");
  await toAdjudicated(api, case2, "revoke");

  const harm = await api("GET", "/supervisor/repeat-harm", { actor: "SV-1" });
  assert.equal(harm.status, 200);
  assert.equal(harm.body.repeat_harm.length, 1);
  assert.equal(harm.body.repeat_harm[0].account_token, "ACCOUNT-A");
  assert.equal(harm.body.repeat_harm[0].revoked_count, 2);
  assert.ok(harm.body.repeat_harm[0].case_ids.includes(case1));
  assert.ok(harm.body.repeat_harm[0].case_ids.includes(case2));

  // 非主管不可见
  assert.equal((await api("GET", "/supervisor/repeat-harm", { actor: "IN-1" })).status, 403);

  // 超过 72 小时未结 → 积压
  advance(73 * HOUR);
  const backlog = await api("GET", "/supervisor/backlog", { actor: "SV-1" });
  assert.equal(backlog.body.overdue_count, 1);
  assert.equal(backlog.body.overdue[0].case_id, case2);

  // 再犯案件裁决后，先前申诉成立的理由依然可查（裁决不可变）
  const history = await api("GET", `/appeals/${case1}`, { actor: "AD-1" });
  assert.equal(history.body.adjudication.outcome, "revoke");
  assert.equal(history.body.adjudication.rationale, "关系与支付材料核实一致");
});
