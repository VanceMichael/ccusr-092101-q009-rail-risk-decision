
const http = require("node:http");
const { openDatabase } = require("./db");
const { actorFrom, requireRole, HttpError } = require("./auth");
const casesApi = require("./cases");
const workflow = require("./workflow");
const dispatcher = require("./dispatcher");
const { createNotifier } = require("./notifier");

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_048_576) {
        reject(new HttpError(413, "payload_too_large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "invalid_json"));
      }
    });
    request.on("error", () => reject(new HttpError(400, "read_error")));
  });
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function bearer(request, expected) {
  if (!expected) return true;
  return request.headers["x-admin-token"] === expected;
}

function createServer(options = {}) {
  const db = options.db || openDatabase(options.databasePath);
  const engineBaseUrl = options.engineBaseUrl ?? process.env.ENGINE_BASE_URL ?? "http://127.0.0.1:8080";
  const engineToken = options.engineToken ?? process.env.ENGINE_SERVICE_TOKEN ?? "";
  const adminToken = options.adminToken ?? process.env.ADMIN_TOKEN ?? "";
  const notifier = options.notifier || createNotifier(options.notifierOptions);
  const deps = { engineBaseUrl, engineToken, notifier };
  const slaHours = options.slaHours || {
    intake: Number.parseInt(process.env.SLA_INTAKE_HOURS || "48", 10),
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname;
    try {
      if (request.method === "GET" && path === "/health") {
        return send(response, 200, { status: "ok" });
      }

      // ---------- 旅客公开端点：只有可申诉事实、清单与进度 ----------
      const publicCaseMatch = /^\/public\/cases\/([^/]+)$/.exec(path);
      if (request.method === "GET" && publicCaseMatch) {
        const accessToken = request.headers["x-access-token"] || url.searchParams.get("access_token");
        const view = casesApi.publicView(db, decodeURIComponent(publicCaseMatch[1]), accessToken);
        return send(response, 200, view);
      }

      // ---------- 内部维护端点 ----------
      if (request.method === "POST" && path === "/internal/sweep") {
        if (!bearer(request, adminToken)) return send(response, 401, { error: "unauthorized" });
        const reclaimed = await dispatcher.reclaimExpiredGrants(db, deps);
        const purged = workflow.purgeExpiredDocuments(db);
        return send(response, 200, { ok: true, reclaimed, purged });
      }

      // ---------- 管理：登记坐席本人关联账号（利益冲突数据来源） ----------
      if (request.method === "POST" && path === "/admin/staff-links") {
        if (!bearer(request, adminToken)) return send(response, 401, { error: "unauthorized" });
        const body = await readJson(request);
        if (typeof body.actor_id !== "string" || typeof body.account_token !== "string") {
          return send(response, 400, { error: "invalid_request" });
        }
        db.prepare("INSERT OR IGNORE INTO staff_links (actor_id, account_token, created_at) VALUES (?, ?, ?)")
          .run(body.actor_id, body.account_token, new Date().toISOString());
        return send(response, 201, { ok: true });
      }

      // ---------- 以下全部为坐席端点，强制身份与角色 ----------
      const actor = actorFrom(request);

      if (request.method === "POST" && path === "/staff/cases") {
        requireRole(actor, "intake_agent");
        const body = await readJson(request);
        const result = await casesApi.createCase(db, { actor, body, engineBaseUrl, engineToken, slaHours });
        return send(response, result.status === "merged" ? 200 : 201, result);
      }

      if (request.method === "GET" && path === "/staff/queue") {
        return send(response, 200, { queue: workflow.staffQueue(db, url.searchParams.get("status") || undefined) });
      }

      if (request.method === "GET" && path === "/supervisor/dashboard") {
        requireRole(actor, "supervisor");
        return send(response, 200, workflow.supervisorDashboard(db));
      }

      const caseMatch = /^\/staff\/cases\/([^/]+)(\/([a-z-]+))?$/.exec(path);
      if (caseMatch) {
        const caseRef = decodeURIComponent(caseMatch[1]);
        const sub = caseMatch[3] || "";
        const caseRow = casesApi.getCase(db, caseRef);
        if (!caseRow) return send(response, 404, { error: "case_not_found" });

        if (request.method === "GET" && sub === "") {
          return send(response, 200, casesApi.staffView(db, caseRef, actor));
        }

        if (request.method === "POST" && sub === "documents") {
          requireRole(actor, "intake_agent");
          const body = await readJson(request);
          return send(response, 201, casesApi.submitDocument(db, caseRef, actor, body));
        }

        if (request.method === "POST" && sub === "document-access") {
          const body = await readJson(request);
          return send(response, 200, casesApi.accessDocument(db, caseRef, actor, body.document_id, body.purpose));
        }

        if (request.method === "POST" && sub === "supplement-request") {
          requireRole(actor, "intake_agent");
          const body = await readJson(request);
          return send(response, 200, await workflow.requestSupplement(db, deps, caseRow, actor, body));
        }

        if (request.method === "POST" && sub === "submit-review") {
          requireRole(actor, "intake_agent");
          return send(response, 200, workflow.submitForReview(db, caseRow, actor));
        }

        if (request.method === "POST" && sub === "reviews") {
          requireRole(actor, "reviewer");
          const body = await readJson(request);
          return send(response, 201, workflow.submitReview(db, caseRow, actor, body));
        }

        if (request.method === "POST" && sub === "temp-grants") {
          requireRole(actor, "supervisor");
          const body = await readJson(request);
          return send(response, 202, await dispatcher.issueTempGrant(db, deps, actor, { ...body, case_ref: caseRef }));
        }

        if (request.method === "POST" && sub === "adjudications") {
          requireRole(actor, "supervisor");
          const body = await readJson(request);
          return send(response, 201, await workflow.adjudicate(db, deps, caseRow, actor, body));
        }

        if (request.method === "POST" && sub === "close") {
          requireRole(actor, "supervisor");
          return send(response, 200, await workflow.closeCase(db, deps, caseRow, actor));
        }

        if (request.method === "GET" && sub === "batches") {
          const rows = db
            .prepare("SELECT batch_id, idempotency_key, purpose, status, attempts, last_error, receipts, created_at, acked_at FROM command_batches WHERE case_ref = ? ORDER BY batch_id")
            .all(caseRef)
            .map((row) => ({ ...row, receipts: row.receipts ? JSON.parse(row.receipts) : null }));
          return send(response, 200, { batches: rows });
        }
      }

      const batchRetryMatch = /^\/staff\/batches\/(\d+)\/retry$/.exec(path);
      if (request.method === "POST" && batchRetryMatch) {
        const batch = await workflow.retryBatch(db, deps, Number(batchRetryMatch[1]));
        return send(response, 200, {
          batch_id: batch.batch_id,
          status: batch.status,
          receipts: batch.receipts ? JSON.parse(batch.receipts) : null,
          attempts: batch.attempts,
          last_error: batch.last_error,
        });
      }

      const notificationRetryMatch = /^\/staff\/notifications\/(\d+)\/retry$/.exec(path);
      if (request.method === "POST" && notificationRetryMatch) {
        const row = await workflow.attemptNotification(
          db,
          notifier,
          Number(notificationRetryMatch[1]),
        );
        return send(response, 200, {
          notification_id: row.notification_id,
          status: row.status,
          attempts: row.attempts,
          last_error: row.last_error,
        });
      }

      return send(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof HttpError || (error.status && error.code)) {
        return send(response, error.status, { error: error.code, detail: error.detail });
      }
      return send(response, 500, { error: "internal_error", detail: error.message });
    }
  });

  // 后台：到期临时放行回收、保留期清理、待确认批次/通知的安全重试（同一幂等键）
  // options.background === false 时关闭（测试场景，改由 /internal/sweep 显式驱动）
  const timers = options.background === false ? [] : [
    setInterval(() => {
      dispatcher.reclaimExpiredGrants(db, deps).catch(() => {});
      retryPendingBatches(db, deps).catch(() => {});
    }, 15_000),
    setInterval(() => workflow.purgeExpiredDocuments(db), 60_000),
  ];
  const originalClose = server.close.bind(server);
  server.close = (callback) => {
    for (const timer of timers) clearInterval(timer);
    return originalClose(callback);
  };
  server.on("close", () => db.close());
  return server;
}

async function retryPendingBatches(db, deps) {
  const pending = db.prepare("SELECT batch_id FROM command_batches WHERE status = 'pending' AND attempts < 10").all();
  for (const row of pending) {
    await dispatcher.attemptBatch(db, deps, row.batch_id);
    // 批次成功后同步放行单状态
    const batch = db.prepare("SELECT * FROM command_batches WHERE batch_id = ?").get(row.batch_id);
    if (batch.status === "acked") {
      if (batch.purpose === "temp_release") {
        const grant = db.prepare("SELECT * FROM temp_grants WHERE batch_id = ? AND status = 'pending'").get(batch.batch_id);
        if (grant) {
          db.prepare("UPDATE temp_grants SET status = 'active' WHERE grant_id = ?").run(grant.grant_id);
          casesApi.recordEvent(db, grant.case_ref, "temp_grant_active", "system", {
            grant_id: grant.grant_id,
            channels: JSON.parse(grant.channels),
            valid_until: grant.valid_until,
          });
        }
      }
    }
  }
  const failedNotices = db.prepare("SELECT notification_id FROM notifications WHERE status = 'failed' AND attempts < 10").all();
  for (const row of failedNotices) {
    await workflow.attemptNotification(db, deps.notifier, row.notification_id);
  }
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "8090", 10);
  createServer().listen(port, "0.0.0.0", () => {
    console.log(`铁路购票申诉与解限服务监听端口 ${port}`);
  });
}

module.exports = { createServer };
