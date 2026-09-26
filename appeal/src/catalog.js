
// 可公开原因类别 -> 最少材料清单
// 坐席不得自行重做风险判断，也看不到模型阈值；清单是核实关系、支付与实名材料的唯一依据。
// scope：敏感材料内容仅授权角色可访问（摘要对所有人可见）。
// retentionDays：案件关闭后的保留期限，到期清除受控引用（sha256 摘要锚点保留）。

const ROLES = {
  INTAKE: "intake_agent",
  REVIEWER: "reviewer",
  ADJUDICATOR: "supervisor",
};

const CATALOG = {
  proxy_purchase_suspected: {
    title: "疑似非本人代购（如代父母/亲属购票）",
    materials: [
      { code: "realname_passenger", label: "乘车人实名信息", kind: "standard", scope: [ROLES.INTAKE, ROLES.REVIEWER, ROLES.ADJUDICATOR], retentionDays: 180 },
      { code: "relationship_proof", label: "代购人与乘车人关系证明", kind: "sensitive", scope: [ROLES.REVIEWER, ROLES.ADJUDICATOR], retentionDays: 30 },
      { code: "purchase_authorization", label: "乘车人购票授权说明", kind: "sensitive", scope: [ROLES.REVIEWER, ROLES.ADJUDICATOR], retentionDays: 30 },
    ],
  },
  payment_subject_mismatch: {
    title: "支付主体与购票账号不一致",
    materials: [
      { code: "realname_passenger", label: "乘车人实名信息", kind: "standard", scope: [ROLES.INTAKE, ROLES.REVIEWER, ROLES.ADJUDICATOR], retentionDays: 180 },
      { code: "payment_authorization", label: "支付人授权/代付说明", kind: "sensitive", scope: [ROLES.REVIEWER, ROLES.ADJUDICATOR], retentionDays: 30 },
    ],
  },
  realname_mismatch: {
    title: "实名信息核验未通过",
    materials: [
      { code: "realname_passenger", label: "乘车人实名信息", kind: "standard", scope: [ROLES.INTAKE, ROLES.REVIEWER, ROLES.ADJUDICATOR], retentionDays: 180 },
    ],
  },
  shared_device_suspected: {
    title: "共用设备批量购票嫌疑",
    materials: [
      { code: "realname_passenger", label: "乘车人实名信息", kind: "standard", scope: [ROLES.INTAKE, ROLES.REVIEWER, ROLES.ADJUDICATOR], retentionDays: 180 },
      { code: "device_use_explanation", label: "设备共用情况说明", kind: "standard", scope: [ROLES.INTAKE, ROLES.REVIEWER, ROLES.ADJUDICATOR], retentionDays: 180 },
    ],
  },
  itinerary_pattern_suspected: {
    title: "高频/异常购票模式",
    materials: [
      { code: "itinerary_explanation", label: "行程用途说明", kind: "standard", scope: [ROLES.INTAKE, ROLES.REVIEWER, ROLES.ADJUDICATOR], retentionDays: 180 },
    ],
  },
};

const DEFAULT_CATEGORY = "proxy_purchase_suspected";

function checklistFor(reasonPublic) {
  const entry = CATALOG[reasonPublic] || CATALOG[DEFAULT_CATEGORY];
  return entry.materials.map((item, index) => ({ ...item, ordinal: index }));
}

module.exports = { ROLES, CATALOG, DEFAULT_CATEGORY, checklistFor };
