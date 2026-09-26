"use strict";

const http = require("node:http");
const { openDatabase } = require("./db");
const { createService, ApiError } = require("./appeals");

function readJson(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) request.destroy(new Error("payload too large"));
    });
    request.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new ApiError(400, "invalid_json", "请求体不是合法 JSON"));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function compile(pattern) {
  const keys = [];
  const regex = new RegExp(
    `^${pattern.replace(/:[^/]+/g, (token) => {
      keys.push(token.slice(1));
      return "([^/]+)";
    })}$`
  );
  return { keys, regex };
}

const ROUTES = [
  ["GET", "/health"],
  ["POST", "/staff"],
  ["POST", "/risk-decisions"],
  ["POST", "/appeals"],
  ["GET", "/appeals/:caseId"],
  ["POST", "/appeals/:caseId/merge"],
  ["POST", "/appeals/:caseId/evidence"],
  ["GET", "/appeals/:caseId/evidence"],
  ["POST", "/appeals/:caseId/transitions"],
  ["POST", "/appeals/:caseId/temp-releases"],
  ["POST", "/appeals/:caseId/close"],
  ["POST", "/commands/dispatch"],
  ["POST", "/commands/:commandId/receipts"],
  ["GET", "/passenger/cases/:caseId"],
  ["GET", "/supervisor/backlog"],
  ["GET", "/supervisor/repeat-harm"],
  ["POST", "/maintenance/sweep"],
].map(([method, pattern]) => ({ method, ...compile(pattern) }));

function createServer(options = {}) {
  const db =
    options.db ||
    openDatabase(options.databasePath || process.env.DATABASE_PATH || ":memory:");
  const now = options.now || (() => new Date().toISOString());
  const service = createService(db, now);

  function requireStaff(request) {
    const actorId = request.headers["x-actor-id"];
    if (!actorId) throw new ApiError(401, "unauthenticated", "缺少 x-actor-id 请求头");
    const actor = service.getStaff(actorId);
    if (!actor) throw new ApiError(403, "unknown_actor", "处理人未登记");
    return actor;
  }

  function requireRole(request, role) {
    const actor = requireStaff(request);
    if (actor.role !== role) throw new ApiError(403, "forbidden_role", `该接口需要 ${role} 角色`);
    return actor;
  }

  async function handle(request, response) {
    const url = new URL(request.url, "http://localhost");
    const route = ROUTES.find(
      (candidate) => candidate.method === request.method && candidate.regex.test(url.pathname)
    );
    if (!route) throw new ApiError(404, "not_found", "接口不存在");
    const params = {};
    const match = url.pathname.match(route.regex);
    route.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(match[index + 1]);
    });
    const body = request.method === "GET" ? {} : await readJson(request);

    // 每个请求先执行到期回收与证明清除，保证临时放行到期自动回收
    service.sweep();

    const path = url.pathname;
    if (request.method === "GET" && path === "/health") {
      return sendJson(response, 200, { status: "ok" });
    }
    if (request.method === "POST" && path === "/staff") {
      return sendJson(response, 201, service.registerStaff(body));
    }
    if (request.method === "POST" && path === "/risk-decisions") {
      const result = service.ingestDecision(body);
      return sendJson(response, result.deduplicated ? 200 : 201, result);
    }
    if (request.method === "POST" && path === "/appeals") {
      return sendJson(response, 201, service.openAppeal(body));
    }
    if (request.method === "GET" && path === `/appeals/${params.caseId}`) {
      const actor = requireStaff(request);
      return sendJson(response, 200, service.staffCaseView(actor, params.caseId));
    }
    if (request.method === "POST" && path.endsWith("/merge")) {
      const actor = requireStaff(request);
      return sendJson(response, 200, service.mergeCases(actor, params.caseId, body.into_case_id));
    }
    if (request.method === "POST" && path.endsWith("/evidence")) {
      const actor = requireStaff(request);
      return sendJson(response, 201, service.submitEvidence(actor, params.caseId, body));
    }
    if (request.method === "GET" && path.endsWith("/evidence")) {
      const actor = requireStaff(request);
      return sendJson(response, 200, { evidence: service.listEvidence(actor, params.caseId) });
    }
    if (request.method === "POST" && path.endsWith("/transitions")) {
      const actor = requireStaff(request);
      return sendJson(response, 200, service.transition(actor, params.caseId, body.action, body));
    }
    if (request.method === "POST" && path.endsWith("/temp-releases")) {
      const actor = requireStaff(request);
      return sendJson(response, 201, service.createTempRelease(actor, params.caseId, body));
    }
    if (request.method === "POST" && path.endsWith("/close")) {
      const actor = requireStaff(request);
      return sendJson(response, 200, service.closeCase(actor, params.caseId));
    }
    if (request.method === "POST" && path === "/commands/dispatch") {
      requireStaff(request);
      return sendJson(response, 200, { dispatched: service.dispatchCommands() });
    }
    if (request.method === "POST" && path.endsWith("/receipts")) {
      // 执行节点回执回调：节点身份由接入层鉴权，这里只校验业务合法性
      return sendJson(response, 200, service.postReceipt(params.commandId, body));
    }
    if (request.method === "GET" && path.startsWith("/passenger/cases/")) {
      return sendJson(
        response,
        200,
        service.passengerView(params.caseId, url.searchParams.get("appellant_token"))
      );
    }
    if (request.method === "GET" && path === "/supervisor/backlog") {
      requireRole(request, "supervisor");
      return sendJson(response, 200, service.supervisorBacklog());
    }
    if (request.method === "GET" && path === "/supervisor/repeat-harm") {
      requireRole(request, "supervisor");
      return sendJson(response, 200, { repeat_harm: service.repeatHarm() });
    }
    if (request.method === "POST" && path === "/maintenance/sweep") {
      requireRole(request, "supervisor");
      return sendJson(response, 200, service.sweep());
    }
    throw new ApiError(404, "not_found", "接口不存在");
  }

  return http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (error instanceof ApiError) {
        sendJson(response, error.status, {
          error: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
      } else {
        sendJson(response, 500, { error: "internal_error", message: "服务内部错误" });
      }
    });
  });
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  createServer().listen(port, "0.0.0.0");
}

module.exports = { createServer };
