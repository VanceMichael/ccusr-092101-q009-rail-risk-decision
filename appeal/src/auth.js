
// 身份与职责分离（SoD）边界。
// 生产部署中 x-actor-* 应由网关注入并签名；本服务据此执行角色约束，禁止坐席自行重做风险判断。

const ROLES = {
  INTAKE: "intake_agent",
  REVIEWER: "reviewer",
  SUPERVISOR: "supervisor",
};

class HttpError extends Error {
  constructor(status, code, detail) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function actorFrom(request) {
  const id = request.headers["x-actor-id"];
  const role = request.headers["x-actor-role"];
  if (!id || !role) throw new HttpError(401, "unauthorized", "缺少身份头");
  if (!Object.values(ROLES).includes(role)) throw new HttpError(403, "forbidden_role", role);
  return { id, role };
}

function requireRole(actor, ...roles) {
  if (!roles.includes(actor.role)) {
    throw new HttpError(403, "forbidden_role", `需要角色：${roles.join("/")}`);
  }
}

module.exports = { ROLES, HttpError, actorFrom, requireRole };
