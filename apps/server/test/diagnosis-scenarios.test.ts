import assert from "node:assert/strict";
import test from "node:test";
import { finalResult } from "../src/execution.js";
import { openDatabase } from "../src/storage.js";
import { diagnosisAnswerFormat, diagnosisScenarios, isDiagnosisScenarioId } from "../src/diagnosis-scenarios.js";

test("finalResult attaches diagnosis block for diagnosis sessions", () => {
  const db = openDatabase(":memory:");
  const now = Date.now();
  db.prepare(
    "INSERT INTO workers(worker_id,boot_id,ledger_id,connection_epoch,online,reconciled,blocked,last_seen) VALUES ('w','boot','ledger',1,1,1,0,?)",
  ).run(now);
  db.prepare(
    "INSERT INTO workspaces(worker_id,workspace_id,repo_id,path,config_version,is_default) VALUES('w','default','local','/tmp',1,1)",
  ).run();
  db.prepare(
    "INSERT INTO sessions(session_id,kind,worker_id,workspace_id,workspace_version,repo_id,path,execution_mode,diagnosis_scenario) VALUES('s','worker','w','default',1,'local','/tmp','diagnosis','post-deploy')",
  ).run();
  db.prepare(
    "INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,input_text,worker_id,state,created_at) VALUES('j','s','c','h','prompt','w','succeeded',?)",
  ).run(now);
  db.prepare(
    "INSERT INTO messages(message_id,session_id,job_id,seq,content_json) VALUES('m','s','j',1,?)",
  ).run(
    JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: "## 结论\n无法确认\n\n## 证据\n\n## 建议的下一步\n运行 curl 健康检查。" }],
    }),
  );
  const result = finalResult(db, "j") as { diagnosis?: { scenario_id: string | null; conclusion: string } };
  assert.ok(result.diagnosis);
  assert.equal(result.diagnosis?.scenario_id, "post-deploy");
  assert.equal(result.diagnosis?.conclusion, "无法确认");
  db.close();
});

test("isDiagnosisScenarioId validates catalog ids", () => {
  assert.equal(isDiagnosisScenarioId("docker-service"), true);
  assert.equal(isDiagnosisScenarioId("nope"), false);
  assert.equal(diagnosisScenarios.length, 3);
});

test("post-deploy prompt and answer format exclude Willcord infra", () => {
  const post = diagnosisScenarios.find((s) => s.id === "post-deploy")!;
  assert.match(post.prompt, /Willcord 发版/);
  assert.match(post.prompt, /trust-ca/);
  assert.match(post.prompt, /Caddy 回环/);
  assert.match(post.prompt, /不要把全机 Docker/);
  const format = diagnosisAnswerFormat("post-deploy");
  assert.match(format, /Willcord 发版/);
  assert.match(format, /trust-ca/);
  assert.match(format, /Caddy 回环/);
  assert.doesNotMatch(format, /检查的是这台主机上的 Docker 与磁盘/);
  assert.match(format, /不要把全机 Docker 与磁盘容量/);
});

test("host scenarios steer at docker or disk, not post-deploy exclusions", () => {
  assert.match(diagnosisAnswerFormat("docker-service"), /Docker 服务与容器/);
  assert.match(diagnosisAnswerFormat("disk-usage"), /磁盘用量/);
  assert.doesNotMatch(diagnosisAnswerFormat("docker-service"), /Caddy 回环/);
});
