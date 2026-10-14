const endReasons: Record<string, string> = {
  completed: "正常完成",
  cancelled_by_user: "用户取消",
  abandoned: "已放弃",
  deadline_exceeded: "超出运行时限",
  budget_tool_calls: "超出工具调用次数",
  budget_tokens: "超出 token 预算",
  budget_model_turns: "超出模型轮次上限",
  worker_disk_full: "机器磁盘空间不足，未执行",
  worker_wait_expired: "等待机器上线超时",
  model_auth_failed: "模型服务拒绝了 API key",
  model_error: "模型服务调用失败，详情见主节点日志",
  model_not_configured: "模型尚未配置完整（缺少 API key 或模型不存在）",
};

export const endReasonLabel = (reason?: string | null) =>
  reason ? (endReasons[reason] ?? reason) : "";
