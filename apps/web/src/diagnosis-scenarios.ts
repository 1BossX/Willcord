/** First-diagnosis scenario entries (full structured results depend on ticket 2). */
export type DiagnosisScenario = {
  id: "docker-service" | "disk-usage" | "post-deploy";
  title: string;
  summary: string;
  prompt: string;
};

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

export function scenarioById(id: DiagnosisScenario["id"]): DiagnosisScenario | undefined {
  return diagnosisScenarios.find((s) => s.id === id);
}
