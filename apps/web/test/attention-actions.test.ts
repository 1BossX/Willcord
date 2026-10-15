import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AttentionActionRow } from "../src/control.tsx";
import { attentionActionView, attentionActionOriginLabel, attentionActionCallLines, retryActionsForWorker, type AttentionAction } from "../src/attention-actions.ts";

const action = (over: Partial<AttentionAction> = {}): AttentionAction => ({
  action_id: "a1".padEnd(32, "0"),
  action: "retry",
  job_id: "j1".padEnd(36, "0"),
  worker_id: "venus",
  created_at: 0,
  evidence: {},
  ...over,
});

test("a recorded retry action shows its reason and suggested action", () => {
  const view = attentionActionView(action({
    reason: {
      origin: "recorded",
      source_job_id: "j1", source_job_state: "failed", source_end_reason: "model_error",
      source_cancel_reason: null, source_session_title: "清理构建缓存",
      source_calls: [{ call_id: "c1".padEnd(24, "0"), tool_name: "bash", status: "not_executed" }],
      new_job_id: "n1",
      summary: "任务「清理构建缓存」（job j1）失败结束后重试。",
      suggested: "先核对副作用。",
    },
  }));
  assert.equal(view.legacy, false);
  assert.equal(view.backfilled, false);
  assert.match(view.note ?? "", /清理构建缓存/);
  assert.deepEqual(attentionActionCallLines(view), ["bash（c1000000）· 未执行"]);
});

test("a backfilled legacy row is labeled as rebuilt from job data", () => {
  const view = attentionActionView(action({
    reason: {
      origin: "backfilled", source_job_id: "j1", source_job_state: "failed",
      source_end_reason: "model_error", source_cancel_reason: null, source_session_title: null,
      source_calls: [], new_job_id: "n1", summary: "（旧版本记录，由任务数据补全）……", suggested: "……",
    },
  }));
  assert.equal(view.backfilled, true);
  assert.equal(view.legacy, false);
  assert.match(attentionActionOriginLabel(view), /旧版本记录/);
});

test("an unexplainable retry row is presented as a legacy item", () => {
  const legacy = attentionActionView(action({
    reason: {
      origin: "legacy", source_job_id: null, source_job_state: null, source_end_reason: null,
      source_cancel_reason: null, source_session_title: null, source_calls: [], new_job_id: null,
      summary: "历史遗留项：无法还原。", suggested: "忽略或关闭。",
    },
  }));
  assert.equal(legacy.legacy, true);
  assert.match(legacy.note ?? "", /历史遗留项/);
  assert.match(attentionActionOriginLabel(legacy), /历史遗留项/);

  // Even without a reason at all the console still says it is legacy.
  const bare = attentionActionView(action({ reason: undefined }));
  assert.equal(bare.reason, null);
  assert.equal(bare.legacy, true);
  assert.match(bare.note ?? "", /历史遗留项/);
  assert.deepEqual(attentionActionCallLines(bare), []);
});

test("non-retry actions get no retry-specific rendering", () => {
  const blocked = attentionActionView(action({ action: "blocked", reason: undefined }));
  assert.equal(blocked.note, null);
  assert.equal(blocked.legacy, false);
  assert.deepEqual(attentionActionCallLines(blocked), []);
});

test("only retry rows render handle and ignore controls", () => {
  const render = (item: AttentionAction) => renderToStaticMarkup(React.createElement(AttentionActionRow, {
    action: item,
    onDone: () => {},
    onError: () => {},
  }));

  const retryMarkup = render(action());
  assert.match(retryMarkup, /标记已处理/);
  assert.match(retryMarkup, />忽略</);

  for (const actionType of ["blocked", "abandon", "unblock", "unblocked"]) {
    const markup = render(action({ action: actionType }));
    assert.equal(markup, "", `${actionType} must not render retry resolution controls`);
  }
});

test("the retry history includes only retry actions for its worker", () => {
  const retry = action();
  const actions = [
    retry,
    action({ action_id: "blocked", action: "blocked" }),
    action({ action_id: "abandon", action: "abandon" }),
    action({ action_id: "unblock", action: "unblock" }),
    action({ action_id: "unblocked", action: "unblocked" }),
    action({ action_id: "other-worker", worker_id: "mars" }),
  ];

  assert.deepEqual(retryActionsForWorker(actions, "venus"), [retry]);
});

test("unknown call statuses are shown as-is, known ones localized", () => {
  const view = attentionActionView(action({
    reason: {
      origin: "recorded", source_job_id: null, source_job_state: null, source_end_reason: null,
      source_cancel_reason: null, source_session_title: null,
      source_calls: [
        { call_id: "a", tool_name: "read", status: "unknown" },
        { call_id: "b", tool_name: "bash", status: "weird-status" },
      ],
      new_job_id: null, summary: "s", suggested: "",
    },
  }));
  assert.deepEqual(attentionActionCallLines(view), ["read（a）· 执行情况未知", "bash（b）· weird-status"]);
});
