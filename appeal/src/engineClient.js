
// 申诉服务访问原执行节点（风控引擎）的唯一出口。
// 只读公开视图（可公开原因类别、各渠道状态），写操作必须携带幂等键，
// 网络层可安全重试：引擎按幂等键去重，首次回执原样重放，不会多次变更状态。

const CHANNELS = ["app", "web", "window", "agent_terminal"];

class EngineError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

async function fetchDecision(engineBaseUrl, decisionRef, token) {
  const url = `${engineBaseUrl}/public/decisions/${encodeURIComponent(decisionRef)}`;
  const headers = {};
  if (token) headers["x-service-token"] = token;
  const response = await fetch(url, { headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new EngineError("engine_unavailable", `公开视图查询失败：${response.status}`);
  return response.json();
}

async function postCommands(engineBaseUrl, decisionRef, token, payload, idempotencyKey) {
  const url = `${engineBaseUrl}/decisions/${encodeURIComponent(decisionRef)}/commands`;
  const headers = { "content-type": "application/json", "idempotency-key": idempotencyKey };
  if (token) headers["x-service-token"] = token;
  let response;
  try {
    response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  } catch (error) {
    throw new EngineError("network_error", error.message); // 调用方将用同一幂等键重试
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* 引擎可能在写库后断连：同样靠幂等键重试取回执 */
  }
  if (!response.ok) throw new EngineError("engine_rejected", body ? JSON.stringify(body) : response.status);
  return body;
}

module.exports = { CHANNELS, EngineError, fetchDecision, postCommands };
