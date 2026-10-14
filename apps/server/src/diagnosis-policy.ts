/** Operator/model-facing summary of diagnosis execution limits (keep in sync with worker `diagnosis::POLICY_SUMMARY`). */
export function diagnosisExecutionPolicyText(): string {
  return `诊断模式执行层限制（必须遵守，worker 会拒绝并返回具体原因）：
- bash 仅允许：docker ps|inspect|logs|info；df；du（须带 -s、-d 或 --max-depth≤5）；systemctl status <unit>；curl（仅本机 http(s)://localhost|127.0.0.1|[::1] 健康检查）；id；ls；pwd；true
- read：工作目录内相对路径，或主机只读路径 /etc/os-release（不要用 .. 或绝对路径访问其他文件）
- write：一律禁止；修复须走「批准后执行」`;
}

export const DIAGNOSIS_INTERCEPT_PROBE_PATH = ".willcord-diagnosis-intercept-probe";
