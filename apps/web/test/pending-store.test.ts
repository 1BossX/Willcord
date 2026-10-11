import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getPendingCount, setPendingLoader, subscribePending, POLL_MS } from "../src/pending-store.ts";

const flush = () => new Promise(resolve => setImmediate(resolve));

test("one poll for the first subscriber, one per interval, none after the last leaves", async () => {
  let calls = 0, devices = [{ state: "pending" }, { state: "approved" }];
  setPendingLoader(async () => { calls++; return devices.filter(d => d.state === "pending").length; });
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let notified = 0;
    const off1 = subscribePending(() => notified++);
    const off2 = subscribePending(() => notified++);
    await flush();
    assert.equal(calls, 1, "a second subscriber does not poll again");
    assert.equal(getPendingCount(), 1);
    assert.equal(notified, 2, "both subscribers hear the change");
    devices = [{ state: "pending" }, { state: "pending" }];
    mock.timers.tick(POLL_MS); await flush();
    assert.deepEqual([calls, getPendingCount()], [2, 2]);
    off1(); mock.timers.tick(POLL_MS); await flush();
    assert.equal(calls, 3, "still polling while one subscriber remains");
    off2(); mock.timers.tick(POLL_MS * 3); await flush();
    assert.equal(calls, 3, "the last unsubscribe stops the timer");
  } finally { mock.timers.reset(); }
});

test("the hook hands React a stable subscribe function, never an inline one", () => {
  // An inline arrow is a new identity every render; React would resubscribe each time and
  // every first subscription polls at once, so live-feed re-renders would flood the API.
  const source = readFileSync(new URL("../src/enrollment.tsx", import.meta.url), "utf8");
  assert.match(source, /useSyncExternalStore\(subscribePending,\s*getPendingCount\)/);
  assert.doesNotMatch(source, /useSyncExternalStore\(\s*(\(|notify|\w+\s*=>)/);
});
