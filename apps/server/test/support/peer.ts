// A scripted main node: the test decides every frame a real worker receives.
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import { requestHash } from "@willcord/protocol";

export class Peer {
  readonly frames: any[] = [];
  private waiter?: () => void;
  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === "heartbeat") return;
      this.frames.push(frame);
      this.waiter?.();
    });
  }
  /** The oldest frame of this type; frames of other types stay queued. */
  async next(type: string, timeoutMs = 15000, match: (frame: any) => boolean = () => true) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.frames.findIndex((f) => f.type === type && match(f));
      if (index >= 0) return this.frames.splice(index, 1)[0];
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}; queued: ${this.frames.map((f) => f.type).join(",")}`);
      await new Promise<void>((r) => { this.waiter = r; setTimeout(r, 50); });
    }
  }
  /** Remove and return every queued frame of this type. */
  take(type: string, match: (frame: any) => boolean = () => true) {
    const taken = this.frames.filter((f) => f.type === type && match(f));
    for (const f of taken) this.frames.splice(this.frames.indexOf(f), 1);
    return taken;
  }
  /** Assert nothing of this type is queued. */
  none(type: string) {
    assert.deepEqual(this.frames.filter((f) => f.type === type).map((f) => f.call_id), [], `unexpected ${type}`);
  }
  send(frame: object) { this.socket.send(JSON.stringify({ protocol_version: 1, ...frame })); }

  async handshake(epoch: number, workerId = "w") {
    const register = await this.next("register");
    this.send({ type: "register_ack", worker_id: workerId, connection_epoch: epoch, reconciliation_required: true });
    await this.next("resume");
    this.send({ type: "ack", worker_id: workerId, connection_epoch: epoch, ack_type: "resume" });
    const reconcile = await this.next("reconcile");
    this.send({ type: "ack", worker_id: workerId, connection_epoch: epoch, ack_type: "reconcile" });
    await this.next("worker_ready");
    return { register, reconcile };
  }

  /** Send a tool call for job-1 and return its identity. */
  call(epoch: number, callId: string, seq: number, tool: string, args: object, workerId = "w", executionMode?: "diagnosis") {
    const request = { worker_id: workerId, job_id: "job-1", call_id: callId, call_seq: seq, workspace_id: "repo", config_version: 1, tool, arguments: args, ...(executionMode ? { execution_mode: executionMode } : {}) };
    const hash = requestHash(request);
    this.send({ type: "tool_call", connection_epoch: epoch, request_hash: hash, ...request });
    return { worker_id: workerId, connection_epoch: epoch, job_id: "job-1", call_id: callId, call_seq: seq, request_hash: hash };
  }
}
