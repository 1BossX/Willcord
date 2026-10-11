/** What a failed model request means, in words a person can act on; the provider's raw reply stays available as detail. */
export type ModelFailure = { summary: string; detail: string };

const rules: Array<[RegExp, string]> = [
  [/\b401\b|invalid[ _-]?api[ _-]?key|incorrect api key|missing authentication|unauthori[sz]ed|authentication/i, "API key 无效或已被撤销，请到 provider 控制台确认后重新输入。"],
  [/\b402\b|insufficient[ _-]?(credits?|quota|balance|funds)|billing|payment required|exceeded your current quota/i, "账户余额或额度不足，请到 provider 控制台充值或检查套餐。"],
  [/\b403\b|forbidden|permission|not allowed|access denied/i, "这个 key 没有使用该模型的权限，请换一个模型或检查 key 的权限范围。"],
  [/\b404\b|model[^.]{0,40}not found|no such model|does not exist|unknown (pi )?model/i, "provider 找不到这个模型，请核对模型名称（可从下拉建议里选）。"],
  [/\b429\b|rate[ _-]?limit|too many requests/i, "请求过于频繁，被 provider 限流了，请稍后重试。"],
  [/\b5\d\d\b|overloaded|unavailable|bad gateway/i, "provider 暂时不可用，请稍后重试。"],
  [/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed|network|timed? ?out|timeout|aborted/i, "无法连接到 provider，请检查主节点的网络、代理和 DNS。"],
];

export function explainModelFailure(raw: string): ModelFailure {
  const detail = raw.trim();
  const hit = rules.find(([pattern]) => pattern.test(detail));
  return { summary: hit ? hit[1] : "模型返回了错误，请核对 provider、模型名称和 API key。", detail };
}

/** A fresh main node has no key until one is bound in the console; jobs cannot run before then. */
export const modelUnbound = (view: { has_key: boolean }) => !view.has_key;
