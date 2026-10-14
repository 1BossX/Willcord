import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRouteHash, routeToHash, writeRoute } from "../src/console-routing.ts";

test("console hash routes round-trip", () => {
  assert.equal(routeToHash({ view: "main" }), "#/main");
  assert.deepEqual(parseRouteHash("#/main"), { view: "main" });
  assert.deepEqual(parseRouteHash(routeToHash({ view: "session", sessionId: "abc" })), {
    view: "session",
    sessionId: "abc",
  });
  assert.deepEqual(parseRouteHash(routeToHash({ view: "worker", workerId: "w-1" })), {
    view: "worker",
    workerId: "w-1",
  });
});

test("writeRoute replace uses replaceState", () => {
  const calls: Array<{ op: "push" | "replace"; url: string }> = [];
  const g = globalThis as typeof globalThis & { window?: Window };
  const prevWindow = g.window;
  const location = { hash: "#/worker/a" };
  const win = {
    location,
    history: {
      pushState: (_s: unknown, _t: unknown, url: string) => {
        location.hash = String(url);
        calls.push({ op: "push", url: String(url) });
      },
      replaceState: (_s: unknown, _t: unknown, url: string) => {
        location.hash = String(url);
        calls.push({ op: "replace", url: String(url) });
      },
    },
  };
  g.window = win as Window & typeof globalThis;
  try {
    writeRoute({ view: "session", sessionId: "x" }, { replace: true });
    assert.deepEqual(calls, [{ op: "replace", url: "#/session/x" }]);
    calls.length = 0;
    writeRoute({ view: "session", sessionId: "x" });
    assert.equal(calls.length, 0);
    writeRoute({ view: "worker", workerId: "b" });
    assert.deepEqual(calls, [{ op: "push", url: "#/worker/b" }]);
  } finally {
    if (prevWindow === undefined) delete g.window;
    else g.window = prevWindow;
  }
});
