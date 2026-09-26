
const assert = require("node:assert/strict");
const test = require("node:test");
const { createServer } = require("../src/server");
const { openDatabase } = require("../src/db");

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function api(port, method, path, { token, header, body } = {}) {
  const headers = {};
  if (token) headers["x-service-token"] = token;
  if (header) Object.assign(headers, header);
  if (body) headers["content-type"] = "application/json";
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const DECISION = {
  decision_ref: "RD-1001",
  account_token: "ACC-1",
  passenger_token: "PAX-1",
  reason_public: "proxy_purchase_suspected",
  rule_revision: 99, // 内部秘密，绝不应出现在公开视图
  decided_at: "2026-09-26T08:00:00+08:00",
  channels: [
    { channel: "app", state: "restricted" },
    { channel: "web", state: "restricted" },
  ],
};

test("原执行节点：公开视图只含可公开原因与渠道状态，不含阈值/规则版本", async (context) => {
  const db = openDatabase(":memory:");
  const server = createServer({ db, internalSecret: "it", serviceSecret: "st" });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const port = await listen(server);

  assert.equal((await api(port, "POST", "/internal/decisions", { token: "it", body: DECISION })).status, 201);
  assert.equal((await api(port, "POST", "/internal/decisions", { token: "wrong", body: DECISION })).status, 401);

  const view = await api(port, "GET", "/public/decisions/RD-1001");
  assert.equal(view.status, 200);
  assert.equal(view.body.reason_public, "proxy_purchase_suspected");
  assert.equal(view.body.channels.length, 2);
  assert.equal("rule_revision" in view.body, false);
  assert.deepEqual(view.body.channels.map((c) => c.state), ["restricted", "restricted"]);

  assert.equal((await api(port, "GET", "/public/decisions/MISSING")).status, 404);
});

test("原执行节点：同一幂等键重试只变更一次状态并原样重放回执", async (context) => {
  const db = openDatabase(":memory:");
  const server = createServer({ db, serviceSecret: "st" });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const port = await listen(server);

  await api(port, "POST", "/internal/decisions", { body: { ...DECISION, decision_ref: "RD-1002" } });

  const payload = {
    case_ref: "C-x",
    commands: [{ channel: "app", action: "release", release_expires_at: "2026-09-27T08:00:00+08:00" }],
  };
  const first = await api(port, "POST", "/decisions/RD-1002/commands", {
    token: "st",
    header: { "idempotency-key": "K-1" },
    body: payload,
  });
  assert.equal(first.status, 202);
  assert.equal(first.body.replayed, false);
  assert.equal(first.body.receipts[0].state_after, "released");
  const etagAfterFirst = first.body.receipts[0].etag_after;

  // 网络重试：同键同体 → 重放，etag 不再增长
  const retry = await api(port, "POST", "/decisions/RD-1002/commands", {
    token: "st",
    header: { "idempotency-key": "K-1" },
    body: payload,
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, true);
  assert.deepEqual(retry.body.receipts, first.body.receipts);
  assert.equal(retry.body.receipts[0].etag_after, etagAfterFirst);

  // 同键不同体 → 拒绝，防止幂等键被复用为新变更
  const conflict = await api(port, "POST", "/decisions/RD-1002/commands", {
    token: "st",
    header: { "idempotency-key": "K-1" },
    body: { case_ref: "C-x", commands: [{ channel: "web", action: "restrict" }] },
  });
  assert.equal(conflict.status, 409);

  // 缺少幂等键 → 拒绝
  assert.equal((await api(port, "POST", "/decisions/RD-1002/commands", { token: "st", body: payload })).status, 400);
});

test("原执行节点：临时放行到期后自动回收为 restricted", async (context) => {
  const db = openDatabase(":memory:");
  const server = createServer({ db, serviceSecret: "st" });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const port = await listen(server);

  await api(port, "POST", "/internal/decisions", { body: { ...DECISION, decision_ref: "RD-1003" } });
  const expiredAt = new Date(Date.now() + 60_000).toISOString();
  await api(port, "POST", "/decisions/RD-1003/commands", {
    token: "st",
    header: { "idempotency-key": "K-TTL" },
    body: { case_ref: "C-y", commands: [{ channel: "app", action: "release", release_expires_at: expiredAt }] },
  });

  // 手工把到期时间拨到过去，再触发回收扫描
  db.prepare("UPDATE channel_restrictions SET release_expires_at = ? WHERE decision_ref = 'RD-1003'")
    .run("2026-09-26T00:00:00+08:00");
  await api(port, "POST", "/internal/reclaim");
  const view = (await api(port, "GET", "/public/decisions/RD-1003")).body;
  assert.equal(view.channels.find((c) => c.channel === "app").state, "restricted");
});
