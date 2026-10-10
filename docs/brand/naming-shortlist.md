# 品牌命名候选核验

日期：2026-10-10。范围：Noderein 与 Willcord 的公开使用、近似名称和数字资产只读查询。没有采购资产或实施工程改名。

## 推荐结论

**将 Willcord 提升为当前优先候选，Noderein 降为备选。**这是品牌评估建议，尚未正式定名。

Noderein 的 Node + Rein 与机器控制面契合，但建议读音 node-rain 与已存在的 NODERAIN 相同。对方提供智能灌溉控制和软件平台，可能造成听写和搜索混淆。Willcord 的 Will + Cord 表达将意志传到远端，适合延续“大脑留在中心，机器只管执行”的文案；需要明确副标题说明运维场景。

## 公开使用证据

- [NODERAIN 官网](https://noderain.com/) 展示智能灌溉产品及 NODERAIN FLUX 软件平台。本轮确认公开品牌使用，不据此推导 Noderein 的法律可用性。
- 搜索 `"Noderein"`、`"Node Rein" software trademark` 未发现明确同名软件产品；近似名称问题仍然存在。
- 搜索 `"Willcord"`、`"Will Cord" software trademark` 和品牌／公司组合，未发现明确同名软件产品。有个人姓名、用户名以及包含 WILLCORD 的公司名记录，不能描述为“无人使用”。
- Willcore 已有软件包 [willcore.core](https://www.npmjs.com/package/willcore.core)，作为 Willcord 的近似拼写线索保留；两者并非同名，是否产生实际混淆尚未测试。

公开搜索不是完整商标检索。本轮没有完成中国、美国、欧盟等目标市场第 9／42 类的官方精确及近似商标查询，不给出法律风险等级。

## 数字资产查询结果

| 查询 | Noderein | Willcord |
| --- | --- | --- |
| `.com` 注册局 RDAP | HTTP 404，无记录 | HTTP 200，有注册记录 |
| `.dev` 注册局 RDAP | HTTP 404，无记录 | HTTP 404，无记录 |
| `.ai` 注册局 RDAP | HTTP 404，无记录 | HTTP 404，无记录 |
| npm 精确包名 API | HTTP 404，无包记录 | HTTP 404，无包记录 |
| crates.io 精确包名 API | HTTP 404，无包记录 | HTTP 404，无包记录 |
| GitHub 用户／组织精确名 API | HTTP 403，未能确定 | HTTP 403，未能确定 |

查询来源：`.com` 使用 `https://rdap.verisign.com/com/v1/domain/<name>.com`；`.dev` 经 rdap.org 转到 `pubapi.registry.google`；`.ai` 转到 `rdap.identitydigital.services`。包名使用 `registry.npmjs.org/<name>` 和 `crates.io/api/v1/crates/<name>`，GitHub 使用 `api.github.com/users/<name>`。

HTTP 404 表示当次接口没有记录，不保证名称可注册、可发布，也不证明不存在保留、溢价或其他限制。注册商报价、续费价格和 GitHub 实际创建可用性仍需核验。

## Willcord 文案草案

> **Willcord**
>
> 大脑留在中心，机器只管执行。
>
> 面向内网与生产环境的 AI 运维控制面。
>
> 模型密钥集中管理，机器无需开放入站端口；断线先对账，未知不重跑。

建议读音：will-cord。暂不加中文音译品牌名。CLI 和服务名继续沿用 WorkerPlane，避免在定名前制造迁移成本。

主域名工作候选：`willcord.dev`。这是偏开发者工具的品牌选择；`.ai` 可作对照。不把已注册的 `.com` 当作必要采购条件。

## 第二轮核验 · 2026-10-10

### 域名实际报价

在 [Porkbun 搜索页](https://porkbun.com/checkout/search?q=willcord.dev) 查询 `willcord.dev`，页面显示可加入购物车，首年 **US$8.75**，续费 **US$12.87／年**。这是具体域名的页面报价，不仅是 TLD 标准价格。按当前价格计算三年 US$34.49，五年 US$60.23；这些是预算计算，未来续费价格可能变化，税费和结算总额未确认。

未加入购物车，未登录或采购。当前建议优先选择 `.dev`，正式购买时以结算报价为准。

### 美国官方商标初筛

进入 [USPTO Trademark Search](https://tmsearch.uspto.gov/)，使用 Wordmark 模式分别输入 `willcord`、`willcore`，两次加载完成后均显示 **No results found**。Live 和 Dead 均选中，未限定类别。

这是两项文字查询的结果，未完成音近、词根、图形和完整商业使用调查；不能表述为“美国无近似商标”或“可注册”。此前发现的 Willcore 软件包使用仍然存在，官方查询无结果不否定实际使用。

尝试进入 [WIPO Global Brand Database](https://branddb.wipo.int/) 时浏览器报告 `ERR_BLOCKED_BY_CLIENT`，没有获得结果，未绕过拦截。中国与欧盟官方检索尚未完成。公开搜索 `WILLCORD trademark`、`WILL CORD trademark` 及官方域名限定未发现明确相关结果，但搜索引擎的空结果不能替代官方数据库检索。

### 当前决策

Willcord 继续作为优先候选，已有具体 `.dev` 可售报价和美国两项文字查询证据。下一步可进行 Willcord 视觉概念设计与目标用户测试；正式改名和商标申请仍须补齐目标市场检索。

## 下一步验证

1. 在目标市场完成精确及近似商标检索，重点记录软件／运维／AI 服务类别与权利状态。
2. `willcord.dev` 页面报价已核验；购买前复核结算总额，GitHub 名称实际可用性仍待核验，不先购买或创建账号。
3. 对未看过名字的目标用户进行看字读音和听音拼写测试，关注 Willcord／Willcore／Will Cord 混淆。
4. 用户确认名称后再做正式 Logo、资产注册及带兼容方案的工程改名。

真实用户测试尚未进行；上述推荐是基于产品定位和本轮证据的判断。
