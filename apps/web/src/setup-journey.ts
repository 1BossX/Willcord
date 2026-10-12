import type { InstallBlocker } from "./install-blockers";
import { installBlockers } from "./install-blockers";

export type WorkerSnapshot = {
  worker_id: string;
  online: number;
  reconciled: number;
  blocked: number;
  schedulable?: boolean;
};

export type SetupSnapshot = {
  modelBound: boolean;
  pendingApprovals: number;
  workers: WorkerSnapshot[];
};

export type SetupStep = {
  id: "ca" | "model" | "worker" | "diagnosis";
  label: string;
  done: boolean;
  blocker?: InstallBlocker;
};

export function setupSteps(snapshot: SetupSnapshot): SetupStep[] {
  const approved = snapshot.workers.filter((w) => w.worker_id);
  const schedulable = approved.some((w) => Boolean(w.schedulable));
  const anyApproved = approved.length > 0;
  const anyOnline = approved.some((w) => w.online);
  const workerBlocker =
    snapshot.pendingApprovals > 0
      ? undefined
      : !anyApproved
        ? installBlockers.workerOffline
        : !anyOnline
          ? installBlockers.workerOffline
          : !schedulable
            ? installBlockers.workerOffline
            : undefined;

  return [
    { id: "ca", label: "信任主节点证书并登录控制台", done: true },
    {
      id: "model",
      label: "绑定模型 API key",
      done: snapshot.modelBound,
      blocker: snapshot.modelBound ? undefined : installBlockers.modelUnbound,
    },
    {
      id: "worker",
      label: "接入 worker 并批准到「可执行」",
      done: schedulable,
      blocker: workerBlocker,
    },
    { id: "diagnosis", label: "完成第一次诊断", done: false },
  ];
}

export function setupReadyForDiagnosis(snapshot: SetupSnapshot): boolean {
  return snapshot.modelBound && snapshot.workers.some((w) => w.schedulable);
}

export function activeSetupBlocker(snapshot: SetupSnapshot): InstallBlocker | null {
  if (!snapshot.modelBound) return installBlockers.modelUnbound;
  if (snapshot.pendingApprovals > 0) return null;
  if (!setupReadyForDiagnosis(snapshot)) return installBlockers.workerOffline;
  return null;
}
