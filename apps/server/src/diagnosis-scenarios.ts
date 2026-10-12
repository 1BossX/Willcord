/** O1-KR1: the three host-level troubleshooting scenarios. */
export type DiagnosisScenarioId = "docker-service" | "disk-usage" | "post-deploy";

export type DiagnosisScenario = {
  id: DiagnosisScenarioId;
  title: string;
  summary: string;
  prompt: string;
};

export const DIAGNOSIS_SCENARIO_IDS: DiagnosisScenarioId[] = [
  "docker-service",
  "disk-usage",
  "post-deploy",
];

export const diagnosisScenarios: DiagnosisScenario[] = [
  {
    id: "docker-service",
    title: "Docker 服务起不来",
    summary: "检查容器与服务状态，定位无法启动的原因。",
    prompt:
      "在这台主机上诊断：有一个 Docker 容器或服务无法正常启动或一直退出。请只做只读检查（例如 docker ps、inspect、logs），给出结论、证据和建议的下一步；证据不足以确认原因时，结论必须写「无法确认」，不要给出确定原因。",
  },
  {
    id: "disk-usage",
    title: "磁盘用量异常",
    summary: "查看磁盘与目录占用，判断是否将满或已满。",
    prompt:
      "在这台主机上诊断：磁盘用量异常或即将写满。请只做只读检查（例如 df、有范围上限的 du），给出结论、证据和建议的下一步；证据不足以确认原因时，结论必须写「无法确认」，不要给出确定原因。",
  },
  {
    id: "post-deploy",
    title: "部署后检查",
    summary: "验证你自己部署的服务在部署后是否健康。",
    prompt:
      "在这台主机上做一次部署后健康检查：针对我自己部署的服务（不是 Willcord 本身），请只做只读检查（例如 systemctl status、访问本机健康检查的 curl），给出结论、证据和建议的下一步；证据不足以确认原因时，结论必须写「无法确认」，不要给出确定原因。",
  },
];

export function isDiagnosisScenarioId(value: unknown): value is DiagnosisScenarioId {
  return typeof value === "string" && (DIAGNOSIS_SCENARIO_IDS as string[]).includes(value);
}

export function scenarioById(id: DiagnosisScenarioId): DiagnosisScenario | undefined {
  return diagnosisScenarios.find((s) => s.id === id);
}

/** Appended to every diagnosis job user turn so the model keeps the required shape. */
export const DIAGNOSIS_ANSWER_FORMAT = `

请用以下三个二级标题组织最终答复（不要省略标题）：
## 结论
## 证据
## 建议的下一步

证据须引用本次真实执行过的工具调用，写明 call_id（与执行详情里一致）并摘录关键输出。建议的下一步只写文字，不要执行修复命令。检查的是这台主机上的 Docker 与磁盘，不限于当前工作目录。`;
