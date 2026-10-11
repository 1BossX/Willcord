import { test } from "node:test";
import assert from "node:assert/strict";
import { explainModelFailure, modelUnbound } from "../src/model-errors.ts";

test("a provider's raw failure becomes a plain sentence, with the raw text kept as detail", () => {
  const raw = '401: {"message":"Invalid API Key","code":401}';
  const f = explainModelFailure(raw);
  assert.match(f.summary, /API key 无效/);
  assert.equal(f.detail, raw);
  assert.doesNotMatch(f.summary, /\{|401/);
});

test("common failures are told apart", () => {
  const cases: Array<[string, RegExp]> = [
    ["402 Insufficient credits", /额度不足/],
    ["403 Forbidden", /没有使用该模型的权限/],
    ["404 model not found: foo/bar", /找不到这个模型/],
    ["429 Too Many Requests", /限流/],
    ["503 Service Unavailable", /暂时不可用/],
    ["fetch failed: ENOTFOUND openrouter.ai", /无法连接到 provider/],
    ["The operation was aborted due to timeout", /无法连接到 provider/],
    ["something nobody planned for", /模型返回了错误/],
  ];
  for (const [raw, expected] of cases) assert.match(explainModelFailure(raw).summary, expected, raw);
});

test("a key-looking secret in a reply is not repeated in the summary", () => {
  assert.doesNotMatch(explainModelFailure("401 bad key fixture-abababababababababababab").summary, /fixture-/);
});

test("the console asks for a model only while no API key is in effect", () => {
  assert.equal(modelUnbound({ has_key: false }), true);
  assert.equal(modelUnbound({ has_key: true }), false);
});
