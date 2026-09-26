
const http = require("node:http");
const { openDatabase } = require("./db");
const engine = require("./engine");

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_048_576) {
        reject(new Error("payload_too_large"));
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
        reject(new Error("invalid_json"));
      }
    });
    request.on("error", reject);
  });
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function authorized(request, secret) {
  if (!secret) return true; // 未配置密钥时仅用于本地/测试
  return request.headers["x-service-token"] === secret;
}

function createServer(options = {}) {
  const db = options.db || openDatabase(options.databasePath);
  const internalSecret = options.internalSecret ?? process.env.INTERNAL_TOKEN ?? "";
  const serviceSecret = options.serviceSecret ?? process.env.SERVICE_TOKEN ?? "";

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        send(response, 200, { status: "ok" });
        return;
      }

      // 外部风控系统写入决定（内部端点）
      const ingestMatch = /^\/internal\/decisions$/.exec(url.pathname);
      if (request.method === "POST" && ingestMatch) {
        if (!authorized(request, internalSecret)) return send(response, 401, { error: "unauthorized" });
        const body = await readJson(request);
        const result = engine.ingestDecision(db, body);
        if (result.error) return send(response, result.status || 400, result);
        send(response, 201, { ok: true, decision_ref: body.decision_ref });
        return;
      }

      // 定时/测试触发的到期回收
      if (request.method === "POST" && url.pathname === "/internal/reclaim") {
        if (!authorized(request, internalSecret)) return send(response, 401, { error: "unauthorized" });
        engine.reclaimExpired(db);
        send(response, 200, { ok: true });
        return;
      }

      const decisionMatch = /^\/public\/decisions\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && decisionMatch) {
        const view = engine.publicDecision(db, decodeURIComponent(decisionMatch[1]));
        if (!view) return send(response, 404, { error: "decision_not_found" });
        send(response, 200, view); // 仅可公开原因类别 + 各渠道状态，无阈值/规则版本
        return;
      }

      const commandsMatch = /^\/decisions\/([^/]+)\/commands$/.exec(url.pathname);
      if (request.method === "POST" && commandsMatch) {
        if (!authorized(request, serviceSecret)) return send(response, 401, { error: "unauthorized" });
        const body = await readJson(request);
        const idempotencyKey = request.headers["idempotency-key"];
        if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
          return send(response, 400, { error: "missing_idempotency_key" });
        }
        if (!Array.isArray(body.commands) || typeof body.case_ref !== "string") {
          return send(response, 400, { error: "invalid_request", detail: "需要 case_ref 与 commands[]" });
        }
        const result = engine.applyCommands(db, {
          idempotencyKey,
          caseRef: body.case_ref,
          decisionRef: decodeURIComponent(commandsMatch[1]),
          commands: body.commands,
        });
        if (result.error) return send(response, result.status || 400, result);
        send(response, result.replayed ? 200 : 202, {
          case_ref: body.case_ref,
          replayed: result.replayed,
          receipts: result.receipts,
        });
        return;
      }

      send(response, 404, { error: "not_found" });
    } catch (error) {
      if (error.message === "invalid_json") return send(response, 400, { error: "invalid_json" });
      send(response, 500, { error: "internal_error" });
    }
  });

  server.on("close", () => db.close());
  // 到期临时放行自动回收（即使申诉侧回收指令延迟也不会继续放行）
  const sweep = setInterval(() => engine.reclaimExpired(db), 30_000);
  const originalClose = server.close.bind(server);
  server.close = (callback) => {
    clearInterval(sweep);
    return originalClose(callback);
  };
  return server;
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  createServer().listen(port, "0.0.0.0", () => {
    console.log(`原执行节点监听端口 ${port}`);
  });
}

module.exports = { createServer };
