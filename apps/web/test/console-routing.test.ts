import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRouteHash, routeToHash } from "../src/console-routing.ts";

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
