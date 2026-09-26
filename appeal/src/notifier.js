
// 通知投递抽象。
// fake：恒成功；fail：恒失败（证明关案闸门拦截未送达）；fail_once：首次失败后成功（证明重试闭环）。

function createNotifier(options = {}) {
  const mode = options.mode ?? process.env.NOTIFIER_MODE ?? "fake";
  const state = { failures: 0 };
  return {
    mode,
    async send(notification) {
      if (mode === "fail") {
        throw new Error("notification_provider_unavailable");
      }
      if (mode === "fail_once" && state.failures === 0) {
        state.failures += 1;
        throw new Error("notification_provider_transient");
      }
      return { provider_ref: `N-${notification.notification_id}-${Date.now()}` };
    },
  };
}

module.exports = { createNotifier };
