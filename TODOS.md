# TODOS

这是当前未完成事项的唯一清单。已完成代码和版本历史写 `CHANGELOG.md`；设计理由写 ADR；阶段证据留在对应 closeout，真实稿与输出留在 Git 外的私有证据目录。

**最新已核实发布（发版 L1）**：截至 `2026-10-10T10:54:03Z`，`c67d1a9b28f7f92303b2328b6251f8ea15ddf598` / `0.31.1.1`（[PR #3](https://github.com/tyuanww/beian/pull/3) 于 `2026-10-10T10:51:01Z` squash 合入 `main`；同 SHA 的可信 `main` push [hangzhou-release 38046344478](https://github.com/tyuanww/beian/actions/runs/38046344478) 成功；公网 `https://www.jianghua.site/api/health` HTTP 200、`ok=true`、`version=0.31.1.1`）。这次是第一次走「离线依赖交接」的生产发版：npm 依赖图 `0.30.3.3 → 0.31.1.1` 变化（server 增 `sharp`），停服前 staging + 停服后换位 + 冒烟全部通过。同日此前两次 run 均在停服前安全失败：[38034011611](https://github.com/tyuanww/beian/actions/runs/38034011611)（`5a9d79d` / 0.31.0.0，未 staged 的依赖变化被拒）、[38043142770](https://github.com/tyuanww/beian/actions/runs/38043142770)（`dc49029` / 0.31.1.0，staged Hono 入口导入缺 UI dist）；两次都未停 8787。只覆盖发版 L1；R05–R07 的 L2/UAT、质量门杭州实跑不因此关闭。

**仓库迁移（2026-10-10）**：原仓 `weiweity/beian` 所在账号被封，仓库已不可访问；代码迁到公开仓 `tyuanww/beian`，PR 编号从 #1 重新开始。下文及 closeout 中指向 `weiweity/beian` 的 PR/run 链接保留为历史证据，现已无法打开，以记录中的 merge SHA、run id 和 health 为准。迁移步骤与剩余缺口见 [仓库迁移操作指南](docs/howto-repo-migration.md)、B03 与 F06。

实施更新：2026-10-09（A1–A5、B/C/D 已本地集成；D 改由 Codex 实现，真实稿/原生验证仍未执行）。以下发布记录沿用历史核实结果，本轮未重新核实生产。截至 `2026-09-15T10:30:43Z`（迁移前）的已核实发布记录为 `e4f3cdb634febbbdb01c319a8236bc04d4c9bbd6` / `0.30.3.2`（[PR #121](https://github.com/weiweity/beian/pull/121) 已合入 `main`、同 SHA 的 [杭州发布](https://github.com/weiweity/beian/actions/runs/34958049990) 成功，公网 health HTTP 200、`ok=true`、`version=0.30.3.2`）。该版本把 TODOS 对齐已核实的 `0.30.3.1` 发版 L1，并补单张结构导出的刀版层 / 独立 OutDir / Mac `--dry-run` 说明。其上一版 `0.30.3.1`（[PR #120](https://github.com/weiweity/beian/pull/120)）对齐 `0.30.3.0` 文档。`0.30.3.0`（[PR #119](https://github.com/weiweity/beian/pull/119)）提供按 SHA-256 选稿的杭州单张结构导出。`0.30.2.0`（[PR #118](https://github.com/weiweity/beian/pull/118)）对齐 F02/TODOS 文档。`0.30.1.0`（[PR #117](https://github.com/weiweity/beian/pull/117)）修了监控 identity 的 UTF-8/UTF-16 BOM。`0.30.0.0`（[PR #116](https://github.com/weiweity/beian/pull/116)）交付独立飞书 bot 通道与杭州计划任务 `beian-monitor-local`。Q05 回执门禁与 R04 仓内探针计划仍以 `0.29.0.0` 为工具发版 L1；默认仍只跑轻量合成，不启动 Blender/浏览器压测或双 100MiB 上传，也不冻结正式预算。Q06.6 A 代码此前已完成发版 L1，生产候选未启用。Q01–Q04 合成补采、限定范围的人工视觉接受与 Q05 三轮 Mac 合成观察已完成，详见各主题；原有 **21 个未闭环主题（P1 10、P2 7、P3 4）**；2026-10-09 新增 R05–R07 后合计 **24 个未闭环主题（P1 10、P2 10、P3 4）**。B01 新增的审稿反馈和历史需求子项不重复计为主题。其中 F02 杭州托管与测试消息已按当前意图收口（未停 8787/cloudflared 做真实掉线，主题框仍开）；B02 放下；B03 保护已生效、归属暂缓。阶段实现与验证记录随下方条目更新；历史发布证据不替代本轮本地回归或业务验收。“待确认”表示未见批准/完成证据，不替用户判断外部事项已办或未办。不再重复派发 Q05 回执、R04 探针、clearcoat 修复、Q06.6 A 或监控核心。

此前发布证据：[PR #102](https://github.com/weiweity/beian/pull/102)、merge `c62caed`、[hangzhou-release 34244831374](https://github.com/weiweity/beian/actions/runs/34244831374) 成功及同次公网 health `0.23.0.0`。仓库外完整记录：`~/Desktop/beian-evidence/2026-09-08-two-pr-ship/REPORT.md`。以下 R01/Q05 的已发布状态复用此证据，不代表业务验收完成。

此前 GLB 发布：[PR #104](https://github.com/weiweity/beian/pull/104)，merge `7380228` / `0.23.2.0`；[hangzhou-release 34318804949](https://github.com/weiweity/beian/actions/runs/34318804949) 成功，杭州来源、Illustrator Session 1、Blender 合同冒烟与同次公网 health/version 已核对。完整记录：`~/Desktop/beian-evidence/2026-09-09-glb-integration/ship/RELEASE.md`。2026-09-09 用户确认当前白色花盒 GLB 画面无问题：镜头、灯光、桌墙切片结案；仅限本例视觉接受，不代替 Q02/Q04 整体、13 稿矩阵、L2/UAT。

此前运维工具发布：[PR #105](https://github.com/weiweity/beian/pull/105)，merge `263e7bd` / `0.24.0.0`；[hangzhou-release 34326190730](https://github.com/weiweity/beian/actions/runs/34326190730) 成功，杭州来源、Illustrator Session 1、Blender 合同冒烟与公网 version 已核对。发布的是 F02 本地告警核心和 R04 采证工具，不代表生产告警接入或资源预算验收。证据：`~/Desktop/beian-evidence/2026-09-09-monitoring-resource-integration/ship/RELEASE.md`。

此前发布：[PR #106](https://github.com/weiweity/beian/pull/106)，merge `0e56152` / `0.25.0.0`；[hangzhou-release 34336262433](https://github.com/weiweity/beian/actions/runs/34336262433) 成功，杭州 runner 来源与公网 health/version 已核对。F02 探测与本地投递工具已发布，真实通知未启用。

此前发布：[PR #110](https://github.com/weiweity/beian/pull/110) merge `78f1594` / `0.26.0.2` 已合入 `main`；[hangzhou-release 34599940457](https://github.com/weiweity/beian/actions/runs/34599940457) 成功，公网 `health.version=0.26.0.2` 已核对。该证据只证明发版 L1。此前 [PR #109](https://github.com/weiweity/beian/pull/109) `10b67d2` / `0.26.0.1` 与功能头 [PR #107](https://github.com/weiweity/beian/pull/107)+[PR #108](https://github.com/weiweity/beian/pull/108) `1e29578` / `0.26.0.0` 仍为历史发布链。

截至 `2026-09-13T11:10:26Z` 的发布证据：[PR #111](https://github.com/weiweity/beian/pull/111) merge `09e5823ea5fc449ac423f877197a923d2fdd9b90` / `0.26.1.0` 已合入 `main`；同 SHA 的 [hangzhou-release 34753582400](https://github.com/weiweity/beian/actions/runs/34753582400) 成功，杭州 runner 来源、Illustrator Session 1 与当时公网 `health.ok=true`、`health.version=0.26.1.0` 已核对，发版 L1 已发布。该历史记录不代表本轮上线，也不替代质量门杭州实跑、真实稿 L2 或 UAT。

此前发布（`2026-09-13T13:00:29Z` 核验）：[PR #112](https://github.com/weiweity/beian/pull/112) merge `8de6dab122d3095aaec55359848d988d3411cb04` / `0.27.0.0`；同 SHA 的 [hangzhou-release 34758465340](https://github.com/weiweity/beian/actions/runs/34758465340) 成功，杭州 runner 来源、Illustrator Session 1 与当时公网 `health.ok=true`、`health.version=0.27.0.0` 已核对。F02 非敏感监控策略配置装载已完成发版 L1；真实告警接入、登录后业务 UI、L2/UAT 不由该记录证明。证据批次：`F02-land-20260913-TFKWwm`。

此前已核实发布：[PR #113](https://github.com/weiweity/beian/pull/113) 于 `2026-09-13T17:01:42Z` squash 合入 `main`，merge `51a6d0a8415aeb0eb461e2dcda7e155c77568a3a` / `0.28.0.0`。最终 PR HEAD `7e736c0903067c0af1aafca60ad5d9b61f749b17` 的 [CI 34769666930](https://github.com/weiweity/beian/actions/runs/34769666930) 两项检查成功；同 merge SHA 的 [hangzhou-release 34770336031](https://github.com/weiweity/beian/actions/runs/34770336031) 成功，`hangzhou-windows` 来源、目标 SHA/VERSION、Illustrator Session 1 与 Blender 合同冒烟已核对。`2026-09-13T17:05:01Z` 公网 health 返回 HTTP 200、`ok=true`、`version=0.28.0.0`，Q06.6 A 代码已完成发版 L1。B 生产装配、C 启用、Windows 异常/断电、正式性能预算、真实稿 L2/UAT 与登录后业务页面仍未验收；不能用合同冒烟成功代替这些证明。仓库外证据批次：`Q066-ship-20260914-Q7sMHL/RELEASE.md`。

此前发布：[PR #116](https://github.com/weiweity/beian/pull/116) / `0.30.0.0` 交付独立飞书 bot 通道与杭州 `beian-monitor-local`；[PR #115](https://github.com/weiweity/beian/pull/115) merge `7f2cf1c` / `0.29.0.0` 为 Q05/R04 工具发版 L1。更早文档发布：[PR #114](https://github.com/weiweity/beian/pull/114) merge `cc74f44` / `0.28.0.1`；[杭州发布](https://github.com/weiweity/beian/actions/runs/34804472389) 成功，仓库外 `docs-land-20260914-vh73em/RELEASE.md`。

## 状态与执行口径

- **Code**：代码已交付；是否已有实现以当前 checkout 和相关 closeout 为准，不按未勾选状态重复开发。
- **L0**：Mac / GitHub-hosted 的单测、类型、质量和合成回归；显式本机 Blender 合成验证单独记录。
- **发版 L1**：可信 `main` 发版事务在杭州验证进程、版本、端口和 Illustrator Session 1 身份链。
- **质量门杭州实跑**：RF-11 Blender 合同冒烟真跑、90 秒同机冻结与 Job Object 成功路径已有证据；独立于发版 L1、正式 baseline 和 L2/UAT。超时杀树及异常恢复的原生证据不由成功路径替代。
- **L2**：杭州真实 Illustrator / Blender + 人工核定金标；**UAT**：刘籽烨按真实工作方式确认可用。没有对应 L2/UAT，不写“生产能力已完成”。
- P1 为质量/验收阻塞；P2 为可靠性、产品及采用完善；P3 为独立后续，含条件性任务。优先级不表示所有事项都要立即开发。
- 主题使用稳定 ID；下列编号是执行子步骤，不另算主题。执行记录写清“主题/步骤 ID、适用 SHA/合同/fixture、交付物、验证结果、未执行项”，再链接对应阶段记录。共享证据只记录一次，由其他主题引用。
- 完成一个子步骤不关闭整个主题；代码、待批准、待现场分别记录。实施前重读当前状态，按 [TESTING.md](TESTING.md) 选择受影响验证；不要把这里的步骤当成现成脚本或已获得执行授权。
- 按单一行为切片推进开发；提交、推送、明确 `/ship`、合并及自动发布分别检查已有授权。Windows 现场、生产注册/默认切换、真实稿外部处理、真实消息和删除按对应授权执行；未批准的外部步骤不阻塞可独立完成的本地实现。

## 2026-10-09 刘籽烨需求工单

来源：本会话已读取的刘籽烨飞书需求和用户补充。五项同批，用户已认可最新交互；最终默认值为六面 PNG/ZIP＋完整净版 1:1 展开 PDF、右侧栏 448px（替代早期 400px）、保守资源初值。**最终实施入口：[执行方案](docs/designs/2026-10-09-r05-r07-final-execution-plan.md)**，涵盖历史全量检索、连续审稿、开发依赖、错误/资源合同及验收要求。该方案阶段按用户要求不重跑 `/autoplan`；随后已获准本地实施，当前证据见[本批本地集成记录](docs/designs/2026-10-09-batch-local-closeout.md)。

此前已接收用户转交的 xAI 外评并纳入 7 项修订，以及独立工程复核的 2 项约束；原型已补交历史检索、连续核对和净版展开交互。历史评审与合成原型检查只作各自阶段证据，不证明最新方案重新通过外评或真实 PDF/Illustrator/Windows 验收。详见[历史方案及评审记录](docs/designs/2026-10-09-r05-r07-review-batch-plan.md)。未创建外部工单或发消息；后续本地提交已获准，未推送/发布，私有稿件和证据不入仓。

后续阶段：用户已要求开始本地并行开发，由 Codex 主 agent 准备 Grok 提示词并负责集成收尾；分工与接口边界见[并行交接合同](docs/designs/2026-10-09-grok-parallel-handoff.md)。已准备独立工作树，按用户最新决定更新为 v2 分工：Codex 负责全部前端与视觉及集成，Grok B/C 负责展开图、压缩与历史后端，D 原生文字后端第二波启动；原 A/B/C 全栈提示词不再派发。A1–A4 与 B/C 已集成：右侧栏、七标签净版/六面、压缩页和服务端历史检索已接线；B/C 集成阻塞已修复。用户随后明确改由 Codex 接手 D、A5 与 E。D 原生提取/可见稿面验证/OCR 融合与 A5 来源证据展示已本地集成，见[原生文字交付记录](docs/designs/2026-10-09-native-text-local-closeout.md)；真实稿/原生验证、PR 和生产发布未进入。

本轮聚焦 **5 个交付切片**，其中 R05–R07 是 3 个新增主题，另外两个归入已有 B01：

| 工单 | 交付目标 | 当前阶段 |
|---|---|---|
| R05 | 保留六面 PNG/ZIP，新增完整净版展开稿，可按原尺寸打印折盒 | Code/本地合成回归完成；仅接受显式完整几何和可信图文分离，原生导出及打印待验 |
| R06 | 图片 / PDF 批量压缩，PDF 自动控制到单文件 10MB 以内 | 前后端与资源隔离接线完成；Windows 工具环境、真实试压/章与画质待验 |
| R07 | 压缩任务与结果接入统一历史记录 | 服务端检索/分页、筛选恢复及压缩详情接线完成；业务验收待做 |
| B01.4 | 审稿同屏看稿与问题、点击定位放大、减少遮挡、解释简短 | A1 已本地集成，复用定位/缩放；连续核对真实业务验收待做 |
| B01.5 | 对可编辑的 Illustrator PDF 增加原生文字候选路径，按真值修正误报/漏标 | D/A5 Code 与合成回归完成；有条件纠正 OCR、保留人工决定，真实金标改善待验 |

本批代码评审发现的 4 项缺陷已完成本地修复：净版印刷图层恢复、压缩重启执行器隔离、下载租约续期/关闭顺序、ZIP 中文文件名。修复增量复审覆盖 8/8 个产品文件，未发现新的明确缺陷；证据、代码身份与验证边界见[评审修复收口记录](docs/designs/2026-10-09-batch-review-fix-closeout.md)。用户随后要求继续，已完成本地提交：净版 `2c12a0f`、压缩 `3e5b307`；未推送/发布，不据此关闭五项工单的真实稿、Windows、打印或业务验收。

另有 **3 条早期业务需求待确认/排期**，详见 B01.H1–H3：不同规格稿件对比、营业执照与 Excel 核对、检测报告结论整理。它们不因本轮确认文件压缩而自动进入开发；检测报告压缩归 R06，报告内容分析归 B01.H3。

计数口径：历史 21 个主题没有被本轮关闭，新增 3 个后为 24 个。主题、交付切片、待确认需求不是同一层级，不能相加成待开发功能数。历史主题中，Q01–Q06、A01–A04、R01、R04、B01、F02 共 14 个仍有验收/现场/实施收口缺口；R02、R03、B02、B03、F01、F03、F05 共 7 个属于待确认、暂缓、条件触发或独立后续。每项的具体状态以下文为准。

DESIGN、界面/作业/结构/资产/架构合同已随本地实现同步；历史发布记录未改，不代表本批已上线。

## 2026-10-11 核对页 A 通铺随发版的跟进

- [ ] **外观「侧栏样式：毛玻璃 / 液态玻璃」随 A 通铺上线删除。** A 通铺（`feat/review-page-a-flat`，deviations.md 第 6、10、39 行）把核对页主侧栏改为实心 `#fbfafc` 并不画 `.sidebar-glass`。本 PR 只在核对页关掉玻璃层，其他页仍在用玻璃侧栏，`AppearancePane.tsx` 的选项此时删除会改动别页，不算顺手改，所以没删。上线 A 通铺的同一版需决定：全站侧栏改实心后删掉该选项及 `data-glass-sidebar` / `liquid` 分支与对应测试；PR 描述要写这条。
- [ ] **核对页 console：React 不认识 `fetchPriority` 属性（改版前就有，不在本 PR）。** `ReviewPage.tsx` 的稿件 `<img fetchPriority="high">` 在当前 React 版本会报「React does not recognize the `fetchPriority` prop on a DOM element」，每次进核对页都出现（/qa-only 2026-10-11 checkpoint 011 重放确认）；`e9a9f8a`（main）已有。修法候选：改小写 `fetchpriority` 属性或升级 React 后再用驼峰。
- [ ] **一次性 404 = `GET /favicon.ico`（开发服务器，改版前就有，不在本 PR）。** /qa-only 首屏看到的「Failed to load resource: 404」已定位：浏览器打开非 HTML 页面（`/api/health` JSON）时自动请求 `/favicon.ico`，Vite :5173 返回 404（`curl` 复现：`/favicon.ico 404`；SPA 页面自己声明了 `<link rel="icon" href="/brand/logo-mark.png">`，所以只有非 HTML 页面会触发）；同一浏览器配置只请求一次，之后走缓存，所以看起来是「首次一次」。重试记录：新上下文进 `/review/a1` ×3、`/review/a2`、`/`、reload、未登录各一次都没有 4xx（未登录只有预期的 `/api/auth/feishu/login` 503，本地没配飞书）；新上下文直接开 `/api/health` ×3，第一次出现该 404，后两次没有。证据 `review-a-impl/net404.log`、`net404b.log`。生产是否同样缺 favicon 未查。
- [ ] **全局侧栏版本号 `.sidebar-version` 是 11px，低于全站最小 13px（改版前就有，不在本 PR）。** 核对页 52px 窄条里也能看到「v0.31.1.12」（/design-review F-001）。

## 推荐执行顺序

| 顺序 | 执行包 | 交付与依赖 |
|---|---|---|
| 本轮需求确认 | R05、R06、R07 与 B01.4/.5 | 先完成工单整理；用户明确暂不验证。2026-10-09 用户明确五项一起纳入本批，独立工作树 `codex/r05-r07-autoplan`；落地方案见[最终执行方案](docs/designs/2026-10-09-r05-r07-final-execution-plan.md)。R06/R07闭环实施，B01界面与误报分切片但不移出本批，历史现场验收不混入本轮 |
| 已完成前置 | 主线/工具发版事实对齐 | 0.30.3.2 发版 L1 已核实（PR #121）。Q05/R04 采证工具已完成发版 L1（0.29.0.0）；Q01–Q05 采证/人工接受记录已归档。F02 杭州托管与测试消息已按当前意图收口。不再重复派发 Q05 回执、R04 探针、clearcoat 修复、Q06.6 A 或监控核心。继续保留 Q06 A/B/C 边界，不重复开发 R01 或 RF-10 |
| 2 | 并行：R04/Q05 实测准备、F02 渠道、B02/B03 资料 | 准备批次已归档。F02 渠道、Mac 测试故障/恢复、杭州托管测试消息均已人工确认。identity `allowRealSend=true`（独立 bot，非产品 `FEISHU_*`）。未停 8787/cloudflared 做真实掉线。B02 放下。B03 归属暂缓。Q05/R04 独占窗口未开跑 |
| 3 | A01–A04 真实样本与人工真值 | A02 其余 12 张杭州结构导出粘贴包已备（仓库外 `a-sample-intake-20260915`）；金标与人工真值仍欠。实际导出另按窗口执行 |
| 4 | Q06.4：Windows 异常路径证明（暂缓） | 用户于 2026-09-08 决定暂不准备隔离机；恢复前确认隔离环境与范围。确认后再推进后续生产装配与综合验收。保留杭州生产环境，不做生产故障注入；成功路径不替代异常证明 |
| 5 | Q06.6 B–Q06.7：生产装配候选与 RF-12 | A 隔离候选代码已发布；B 仍依赖 .4 与八点审计。默认保持关闭，综合回归和耐久性分别取证 |
| 6 | Q06.8–Q06.9：授权发布、受控验收与 RF-13 | 发布证据齐全后按批准的样本/操作者范围验证；真实稿通过后再作业务开放或默认切换决定 |
| 独立推进 | R01 现场计划、B01 采用观察 | 不必等全部渲染任务结束；代码/生产动作仍按各自范围执行 |
| 迁移收尾（优先） | B03 主分支保护、F06 迁移清单 | 新仓 main 无保护，任何直推都会触发生产；先经授权重建保护，再做 secrets/凭据/镜像清单 |
| 条件触发 | R02/R03、F01、F03/F05、F07/F08、B02 | 先满足需求、证据或瓶颈条件，不提前扩范围。B02 放下后，真稿出境处理仍不得开始 |

RF-10–RF-13 的原始依赖见 [ADR-007 §20.7](docs/adr-007-packaging-render-fidelity.md#207-grok-可执行任务包)。下面 Q06 对执行包细分，未新增 RF 阶段。真实稿样本准备可以提前；实际调用、验收及业务开放分开。

## P1 — 包装 3D 渲染真实感与清晰度（6 项）

主计划：[ADR-007](docs/adr-007-packaging-render-fidelity.md)。据交付记录，RF-00–RF-09 已交付代码已合入主线；RF-06–RF-08 的新方案仍限诊断，生产默认未切换；RF-09 发布与覆盖限制见 [交付记录](docs/designs/packaging-quality-rf09-closeout.md)。下面列剩余工作，不重开已完成的几何、材质或浏览器实现。

- [ ] **Q01 — 批准渲染质量基线与门槛**

  状态：2026-09-08 已用本机 Blender 5.2.0 LTS 完成固定合成现状采集（6个矩形盒+1个明确不支持圆柱，runtime pass；identity 运行后复核通过）。报告/接触表归档在仓库外 beian-evidence/2026-09-08-next-stage/quality-candidate；0.23.0.0 已经用户批准冻结仅限 Mac 合成现状回归的[正式基线](workers/packaging/fixtures/render-quality/baselines/README.md)。修正 PNG 元数据误报后按新评测器身份重采六个矩形夹具，60张图片像素与旧采集一致；普通评测只读与像素漂移拒绝已验证。human pending、production_ready=false；不是 RF-06–08 候选或 Windows/真实稿验收，耗时不作独占资源阈值。Q01 的 Mac 现状回归锚已落实，其余质量/人工验收仍开放。

  Q01–Q04 共用补采（2026-09-13，源码 `a9e77ac`，当时主线 `78f1594`）：RF-07 四盒×三色管、RF-06 四材质×正反、80³ 壳共 17 个合成 job 已完成，17/17 GLB 合同通过，最大尺寸误差 `8.55e-06 mm ≤ 0.5 mm`。前后身份核对通过，正式 baseline、manifest、生产 registry 和默认值未改，补采时 winner 未选定；后续色管方向、四材质和 80³ 壳的限定视觉接受分别见 Q04/Q03/Q02，原始产物与报告不补写。仓库外验收批次：`Q/recapture-20260913-163233-acceptance/REPORT.md`；其中 clearcoat 负向盲区已由 PR #111 修复并回验原 17 个 GLB，不再作为待开发项。其余阈值、Windows/真实稿与相应人工质量批准仍开放；该补采不是 0.28.0.0 身份的新实跑。

  1. 固定评测输入：列出脱敏 fixture、profile/registry/contract、Blender 版本、分辨率及同机资源条件，检查旧证据是否仍适用。
  2. 生成可审阅的现状报告、contact sheet 和阈值候选，分开确定性错误、合成回归与人工视觉观察；不同身份只做标明差异的实验对照，不冒充同基线回归。
  3. 提交具体 baseline/阈值及适用范围供人工批准；获准后显式更新并验证普通评测不会改写。**验收：批准人、版本/身份、阈值、适用范围和复测结果齐全。** 未批准时保留 missing/mismatch，不自动选赢家。

  依据：[RF-08 对照与限制](docs/designs/packaging-quality-rf08-closeout.md)。私有真稿在杭州只留哈希、评分和结论的可追溯记录。

- [ ] **Q02 — 矩形花盒真实感验收**

  状态：RF-05 显式纸盒壳、family/GLB 合同已有。0.23.2.0 GLB 默认斜角、复位和盒身取景已上线，当前白盒画面获用户接受；细长/矮宽及 80³ 壳补采见 Q01。2026-09-13 用户看过 `recapture-20260913-163233/cube-80/job/front_right.png` 与 `back_left.png` 后答复“可以”，接受这批 80×80×80 mm 壳的正反静帧外形与边角。对应已有 `packshot-carton-geometry-v1`（Standard、白卡无涂层），仅覆盖 Mac 合成静帧，不推广到其他比例、动态 GLB 或 Windows/真实稿，也不批准默认切换或生产启用。后续另获授权的 A 阶段实现见 Q06.6；完整样本矩阵与相应范围的人工验收仍待完成。

  1. 依据 [RF-05](docs/designs/packaging-quality-rf05-closeout.md) 列出实际支持边界，准备细长、矮宽、近立方及宽深不同的合成矩形盒。
  2. 检查外尺寸、纸板厚度、边缘/折角、六面 UV/方向、GLB 与静帧一致性；接触影/轮廓高光与 Q04 共用评测。发现可复现缺陷才拆独立修复片并回归。
  3. 在 Q06.9 / A02 中完成真实稿对照与人工结论。**验收：支持样本及拒绝边界清楚，尺寸/六面不回退，真实感量表已核定。** 没有可靠 closure hint 不猜拼缝/折痕，不加白盒特例滤镜。

- [ ] **Q03 — 纸材、油墨与涂层分层验收**

  状态：RF-06 已交付白卡/牛皮纸、process ink、none/哑膜/上光、微法线及 GLB 子集校验；补采与 clearcoat 修复见 Q01。2026-09-13 用户看过 8 张正反静帧后答复“不用调整”，接受本批白卡无涂层、白卡哑膜、白卡上光、牛皮纸无涂层的静帧视觉表现，不是四选一。对应 `recapture-20260913-163233/rf06-materials/anonymous/` 的 C、D、B、A（映射见同组 `candidate-map.json`），仅覆盖 60×35×110 壳、Standard、Mac 合成样本。不替代 GLB 动态视觉、Windows/真实稿、材质金标或正式基线批准；不填写单一 winner、不改白卡 none 默认，也不开放生产注册。外部验收与受控接线仍待完成。

  1. 复核 [RF-06](docs/designs/packaging-quality-rf06-closeout.md) 四材质 × 正反视角的证据身份和产物可用性，列清静帧与 GLB 支持差异；证据失效时补对应合成验证。
  2. 在 Q06.4–Q06.5 取得 Windows/Blender 证据，在 Q06.9 做私有真稿材质盲评；同一记录复用到 Q01，不能把机器通过写成人工通过。
  3. 依据批准的候选，经 Q06.6/Q06.8 完成适用范围内注册并核验历史 profile 不变。**验收：材质真实稿结论、基线批准、受控注册与回退证据齐全。** 深色纸、金属、珠光、透明窗、局部 UV 仍不支持，另立项；深色印刷盒不等于深色纸。

- [ ] **Q04 — 棚光、白盒边界与色彩管理验收**

  状态：RF-07 尺寸归一三灯棚和三种色彩变换诊断已有，补采见 Q01。2026-09-13 用户选择 `recapture-20260913-163233/rf07-matrix/contact-sheet.png` 接触表 C 列（映射为 Standard）作为后续视觉候选方向；仅为四盒正面缩略对照的 Mac 合成偏好，不构成正反细图/材质/真实稿质量批准，也不单独授权 upgrade 接线或生产启用。保留 Standard、原默认、正式 baseline 和原始 winner 记录不变；后续独立的 A 阶段授权与实现见 Q06.6。0.23.2.0 浏览器 GLB 灯光与显示桌墙切片已上线并获当前白盒视觉接受；场景墙固定、背面不可见、接触影为近似。此接受不批准 Blender 色管/材质默认变更，不重复派发无证据的镜头/墙体优化。

  1. 按 [RF-07](docs/designs/packaging-quality-rf07-closeout.md) 复核 Standard / Khronos PBR Neutral / AgX 受控对照，补齐白盒分离、边缘连续、暗阶、正反协调与接触影证据；纯色盒不用于评价文字保留。
  2. 经 Q06 的 Windows 与真实稿流程进行盲评，记录候选的接受/拒绝理由，与 Q01 共用阈值和人工审批记录。
  3. 仅在对应候选获准后，通过 Q06 的受控注册/发布验证效果及回退。**验收：同机对照、真实稿金标、选择记录与注册证据齐全。** 批准前保持 Standard、原默认与正式 baseline 不变。

- [ ] **Q05 — 端到端字体清晰度与浏览器性能**

  状态：RF-08 诊断采样、RF-09 card→full/下载冻结和 RF-10 报告字段已有；2026-09-08 已整合 Grok 的浏览器性能切片，随 PR #100 合入主线，已于 0.23.0.0 发布：同尺寸画布重绘、卸载/导出释放、灯箱换代来源隔离及旧图初始尺寸处理。2026-09-13 增加 Q05 预构建测量隔离（`BEIAN_Q05_DIST`，默认仍自建构建）及 GLB「声明无 clearcoat、实际有效涂层」负向合同；二者的 Code/L0 切片已随 PR #111 / `0.26.1.0` 发布，发版 L1 证据见上文该版本记录，不勾掉本主题。本机合成已采集 heap/rAF，尚非真实环境预算；Q06.9 登录后实机、字体清晰度、杭州网络及真实稿 L2/UAT 仍待验。原始证据在仓库外 `~/Documents/beian-q05-browser-perf-20260908/`，整合记录在 `~/Desktop/beian-evidence/2026-09-08-q05-f04-integration/`。

  三轮补采已完成（`2026-09-13T11:56:23Z–11:57:02Z`，`09e5823` / `0.26.1.0`，不是等待开跑）：每轮两条 Playwright 用例通过，命令退出码均 0、无重试；六份原始 JSON 哈希与身份经主 agent 复核一致，预构建模式不含 UI 构建。各轮 A 有 6 样本、B 有 11 阶段；10 阶段 cache 探针可用，离页阶段为 `not_assessed`，不证明缓存/显存释放。只接受为 Mac 合成观察，不是独占预算、性能改善、Windows 或 L2/UAT。回执身份不符仅记录不阻断，旧版不得直接用于长期复用；本轮身份已独立核验，不为此重采。仓库外验收批次：`AI3-q05-current-sampling-20260913/MAIN-ACCEPTANCE.md`。保留原采样身份，不给旧产物补盖 0.28.0.0 版本。

  本地工具切片已随 [PR #115](https://github.com/weiweity/beian/pull/115) / `0.29.0.0` 完成发版 L1（merge `7f2cf1c`，杭州发布 34848812422，公网 health `0.29.0.0`），不勾主题：Q05 回执与轮执行器已收编到 `scripts/resource-stress/`，身份/缺产物/采样故障变为非零退出、失败后不续轮；保留合法离页 `not_assessed`。仅用合成 payload 验证，没有重采浏览器、改写旧六份 JSON 或提升旧证据层级。合成验证记录：`q05-r04-evidence-gates-20260914-ABEYV5/REPORT.md`；后续评审与修复回归见 `q05-r04-review-20260914-C4co2W/REVIEW.md`。发版 L1 不等于正式性能预算、杭州网络、登录后实机或真实稿 L2/UAT；不再重做回执门禁。

  2026-09-14 实测准备（未开跑）：当前 HEAD `7f2cf1c` / `0.29.0.0` 身份完整；2026-09-13 预构建与三轮观察不得补盖本版本。若获准窗口，须为该 SHA 新建 `buildQ05ArtifactInto` 预构建并设 `Q05_WINDOW_CONFIRMED=1`。准备记录：`~/Desktop/beian-evidence/closeout-prep-20260914-r04plan/REPORT.md`。

  1. 复用 RF-10 已交付的 generation/eval 三层字段与采样接线：每次采样记录 source/target/projected ppm、像素预算、重采样及合同身份；核验现有缺失/超预算/身份不符的失败路径，不新增公开下载 key。
  2. 测 card 可见、full 网络/解码/替换各阶段、连续切代/resize/离页的 heap 和帧预算；与 R04 共用资源测试。保存同 fixture、同机前后记录；DOM/rAF 时间不能冒充屏幕合成精确时刻。
  3. 在 Q06.9 完成登录后的实机界面和真实稿全过程：预览、重试、旧单、切代、灯箱、下载与印刷面读字。**验收：采样报告、性能记录、真实稿 L2 与 UAT 齐全。** 源 PDF 细节不足要单列，不能用提高像素数证明清晰。

  依据：[RF-08](docs/designs/packaging-quality-rf08-closeout.md)、[RF-09](docs/designs/packaging-quality-rf09-closeout.md)、[F 合同](docs/designs/packaging-quality-f-contract.md)、[高光保护](docs/designs/packaging-quality-highlight-transfer.md)、[历史浏览器观察](docs/designs/packaging-quality-rfe02-browser-findings.md)。`packshot-projection-sampling-v1`、F 均未替换默认；生产采样仍为 `minimum-floor-v1`。B5 有限同 fixture 对照、B7 隔离页检查及真实 Claude 路由不可用的覆盖限制不作完整验收。3D 用于看形，`read_*` 是验字事实源。

- [ ] **Q06 — 质量门、Windows 运行链与综合验收**

  状态：RF-10 与 RF-11 已交付 Code/普通 L0；RF-11 质量门杭州实跑已有证据。Mac 合成现状 baseline 已按 Q01 获批冻结；剩余为原生异常路径、生产接线/注册、RF-12/13、Windows/真实稿与人工质量批准和断电耐久性。RF-03/04 已有存储/API/UI，不重复实现；先核对后续证据是否已补齐历史限制。

  | 步骤 | 执行内容 / 单独交付物 | 依赖与完成标准 |
  |---|---|---|
  | Q06.1 · RF-10 盘查（已交付） | evaluator/runtime verifier/schema 复用已随 RF-10 落地 | `0490e46` / `0.21.44.0`；后续只核验缺口，不另建平行工具 |
  | Q06.2 · RF-10 身份与三层门（Code/L0 已交付） | runtime hard / fixture regression hard / warning+human 独立字段，generation/eval 同源接线 | `0490e46`；真实任务 fixture 为 `not-run`，human 独立 pending，production_ready=false；Mac 合成现状 baseline 已批准；Windows/真实稿未验收 |
  | Q06.3 · RF-10 工具与报告（Code/L0 已交付） | CLI、JSON metrics、contact sheet、identity diff 与显式 baseline 更新 | `0490e46`；命令见 TESTING 与 worker README；普通运行不更新 baseline；Q01 已获批 Mac 合成现状范围，其他范围仍需批准 |
  | Q06.4 · RF-03 平台欠项（用户暂缓） | Windows 原生 Job Object/进程树验证：原子归属、父先退/后代、取消、内存限制、Resume 前 supervisor 崩溃及重启恢复 | 已有模型测试不等于原生；2026-09-08 用户暂缓隔离 Windows 验证，未执行生产故障注入。该前置证据补齐后再评估主 Node 桥创建能力 |
  | Q06.5 · RF-11（Code/L0、杭州实跑已交付） | 独立 wrapper 接可信 main transaction fence，只写 RUNNER_TEMP，复用 generation/GLB/hash 门 | `3fcfea75` / `0.21.46.0`，[run 34191398011](https://github.com/weiweity/beian/actions/runs/34191398011) 真跑约 62s，TimeoutMs=90000，Job Object 成功路径通过；缺已解析 Blender 时会跳过，跳过不算通过；超时杀树分支未走到 |
  | Q06.6 · 生产接线候选（整项未完成） | A 显式临时 runtime 的固定纸盒壳 upgrade 已交付 Code/L0 和单次 Mac 原生合成正常路径；B 生产装配、C 启用仍未完成，见下方补记 | A 候选开发不依赖 .7；A→B 须 Q06.4 与既定八点审计，B→C 须 Q06.7/.8 及明确授权。默认不注册生产 runtime，注册范围、默认选择、历史重放分别核对；A 代码发版不等于生产准入 |
  | Q06.7 · RF-12 | 对最终候选做全量 L0/type/UI build/quality/相关 E2E 与显式合成 Blender 验证；旧单/g0/current、审计、资源释放及回滚演练；补断电耐久性证据 | 依赖 RF-00–RF-11 与纳入候选的 .6；已有相关证据有效则复用；进程崩溃模型、实际 Windows/断电分别标明，断电验证仅限获准隔离环境；形成 closeout，不触碰真实在途作业 |
  | Q06.8 · 发布与受控验收准入 | 明确 ship/合并自动发布授权；核对最终 PR HEAD CI、merge SHA、同次可信发布、杭州来源和公网版本；按批准范围注册/开放验收候选 | 依赖 .7 与必要的质量批准；主桥/生产 adapter/候选 profile/默认切换分别核对，不能因代码上线自动放开；限定样本与操作者的验收不等于全量业务开放 |
  | Q06.9 · RF-13 | 杭州私有真稿 L2 + 刘籽烨 UAT：旧新盲评及上传→等待→看形→背景/灯光→原图/下载→印刷面 | 依赖 RF-12 landed、L1 green 与候选准入；复用 A01/A02 金标，每例留源稿 hash、旧新合同 hash、操作者、时间、评分/结论与拒绝原因；真实稿和输出不进 Git |

  Q06.6 A 补记（2026-09-14）：显式 `upgradeCandidate` 固定 `packshot-carton-geometry-v1` ID/声明 SHA，HTTP 不接收 profile 字段，Python 缺字段仍 `upgrade_unwired`；先验证 RF-02 源再解析绑定结构。既有平台门允许 darwin/linux、拒绝 win32，本次实跑仅 Mac；生产关闭来自默认无注册、临时根和平台门，不能把 `productionEnabled=false` 当独立防护。合法已有代的 history/activate 仍可用。完整本地门禁及 9/9 合成 E2E 已通过；单次 Mac 原生证据绑定 `0b9cd4b`，不是最终发布树重跑，详见 [runtime 收口补记](docs/designs/packaging-quality-rf03-runtime-closeout.md)。未改 registry、默认模板或正式 baseline；`production_ready=false`、human pending，Q06.6/.7/.8、Windows/断电/真实稿/人审仍不勾完成。

  **主题收口：适用步骤的开发、平台、发布、L2/UAT 与批准证据均可追溯。** 某候选被拒绝应记录“不支持/不开放”，不能把跳过登记为通过。真实软袋、天地盖、抽屉盒、圆筒等新 family 仅在矩形 carton L2/UAT 后按业务失败样本独立立项。

  依据：[RF-03 运行链与剩余外部门禁](docs/designs/packaging-quality-rf03-runtime-closeout.md)、[RF-04 能力边界](docs/designs/packaging-quality-rf04-closeout.md)、[ADR-007](docs/adr-007-packaging-render-fidelity.md)、[发布合同](docs/contracts/release.md)、[Windows README](scripts/windows/README.md)。

## P1 — 已有代码仍欠生产/业务验收（4 项）

- [ ] **A01 — 膜袋 v1 杭州金标**

  状态：已有分流与 3 mm 薄盒预览。2026-09-15 本机绑定了正负样本路径（缺 26H24A-7袋装原件与一页多袋）。杭州金标未跑。

  1. 确认样本使用许可和人工预期：正样本为“膜袋”且两块相近闭合刀线；负样本至少包含 5 片面膜花盒、`7袋装花盒`、2-up 花盒、一页多袋。
  2. 在获准的杭州流程逐样本验证结构分流、薄盒标签及预览；记录错误分流，按通用合同修复后重验受影响样本。
  3. 人工签认每例支持/不支持及理由，关联 Q06.9。**验收：正负样本金标齐全；只证明膜袋薄盒预览，不宣称真实袋体。** 依据：[膜袋验收](docs/pouch-v1-acceptance.md)。

- [ ] **A02 — PackagingStructure V2 真实稿矩阵**

  状态：代码与脱敏矩阵已有。2026-09-15 用户确认 13 份打烊台路径；解析尺寸与盒身四面当候选（顶/底未解析，Phase 0 仍 pending_manual）。杭州 Session 1 已对译龄紧颜胶原棒 26F23A 导出 structure 成功并确认刀线；其余 12 张未导。本机 13 份 SHA-256 已复核；其余 12 张对本地 `.ai` 的 `export_one_structure.py --dry-run` 12/12 payload 与粘贴包哈希/刀层一致（5 刀版、7 刀线），不启 Illustrator。杭州粘贴包在仓库外 `~/Desktop/beian-evidence/a-sample-intake-20260915/hangzhou-export-remaining-12.ps1`。非金标。

  1. 在私有环境列出 13 份稿的哈希、结构族、预期六面/尺寸与待确认项，先取得人工真值，不把算法输出当真值。
  2. 按批准范围跑杭州 Illustrator→结构→切面→Blender→网页；核对选层、刀线/印刷内容、六面方向与 GLB，记录失败位置。
  3. 逐份人工批准或明确不支持；每个受支持结构族至少留一份黄金样本，复用至 Q02/Q06.9。**验收：13 份均有结论，支持族都有可追溯金标。** 依据：[ADR-005](docs/adr-005-packaging-structure-v2.md)。

- [ ] **A03 — Illustrator 无人值守重稿 L2**

  状态：结果文件完工、saving 禁杀、busy 排队及 1260 秒外层合同已交付；欠 26H21A 真实重稿证明。

  1. 确认 26H21A 使用许可、预期产物、现场操作者与可执行窗口；只读核对 Agent/交互桌面及在途状态。
  2. 获准后运行真实重稿，记录 busy 排队、saving/完工文件、耗时、结束状态及产物完整性；不为模拟故障强杀正在保存的真实稿。
  3. 人工核对产物及是否需要干预；有缺陷则记录复现/回归。**验收：该真实稿全过程与结论完整，身份冒烟不替代重稿。** 依据：[控制面合同历史](docs/designs/illustrator-unattended-control.md)。

- [ ] **A04 — 对红真实改稿金标**

  状态：第二份 PDF 与签字/对红门已有；欠业务金标。

  1. 由刘籽烨提供获书面许可的旧 PDF、新 PDF、发给设计的话、二校真值；若涉及外部处理，先满足 B02。
  2. 跑获准的对红流程，逐条核对 `open_issues` 的字段/应印/实读与签字约束；验证非空 `hits_v2` 优先、空数组回退第一轮。
  3. 人工签认漏标/误报及疑点结构，再基于样本决定是否另开空格规则修复。**验收：金标与行为结论齐全；失败/完成单不能签字，干净签字单不能再对红，指定四类 pending 不挡签字。** 细则：[审稿合同](docs/contracts/review.md)。

## P2 — 作业可靠性与打样单完善（5 项）

- [ ] **R01 — 补印刷面进入持久队列 / 发版 drain**

  状态：Code 与受影响 L0/合成浏览器回归已完成，随 PR #100（`004ed374` / 0.22.0.0）合入主线，已于 0.23.0.0 发布。`/print-faces` 持久入队后立即返回 202，同单在途幂等、跨单串行，发版可见补面状态；保留成片 done。实现、红绿回归和恢复边界见 [R01 交付记录](docs/designs/print-face-queue-closeout.md)。杭州补面业务、恢复及在途 drain 验证仍待执行；发版 L1 不替代这些验证。

  1. **本地已完成**：按 [作业合同](docs/contracts/jobs.md) 固化 admission、持久状态、执行归属与发版围栏，以及跨用户碰撞、同单并发、重启/响应丢失的行为。
  2. **本地已完成**：复用现有作业体系接入持久队列及围栏；与出图版本互斥/托管代规则兼容，不新增 `/api/jobs`。
  3. **合成回归已完成，现场待验**：已覆盖碰撞、重启恢复、重复请求及在途排干；完整资源压力矩阵仍归 R04，杭州和断电验证未执行。**验收：发版可见在途补面，恢复不丢失持久事实且不会重复写坏产物；杭州验证另记。**

- [ ] **R02 — 真金属地 / 木桌预设**

  状态：待业务依据与素材。

  1. 收集用户拒图及具体问题，确认预设目标和许可清晰的材质资产；需求不成立则记录暂缓。
  2. 基于已有 pass + 浏览器 compositor 做独立预设切片，与设计/成片合同核对；切换背景不重新排 Blender，木桌不设为默认。
  3. 以同一代图检查预览/下载一致性、边缘与接触效果并请业务验收。**验收：素材许可、接受样例、合成回归齐全。**

- [ ] **R03 — 新单 PPT 与打样看板信息**

  状态：待确认 grounded 新单是否仍需要 PPT、看板具体新增字段。

  1. 确认使用者、PPT 用途/必要内容、看板字段及数据来源；分别决定做或暂缓。
  2. 需求成立后拆两个独立切片：浏览器/OOXML 输出合同与实现；看板一行信息布局与实现，不混成一个大改。
  3. 分别核验 PPT 内容/图片/代际身份及实际打开结果、看板字段正确性与密度。**验收：业务签认；看板保持一行高密度，不扩成重复卡片。**

- [ ] **R04 — 切面与渲染资源压测**

  本地工具切片已随 [PR #115](https://github.com/weiweity/beian/pull/115) / `0.29.0.0` 完成发版 L1（merge `7f2cf1c`，杭州发布 34848812422，公网 health `0.29.0.0`），不勾主题：合成套件消费预期退出码/取消事实，异常立即停组；`--repeat` 逐轮身份与原件哈希、min/median/max 汇总，行为通过与有效预算分开。五个业务探针已收入 `scripts/resource-stress/probes/`，`measure.py`/`write_report.py` 由现有采样器替代；`plan` 把矩阵占位符解析为仓内 argv，不执行产品负载。多轮入口仍只覆盖工具自带合成套件。未启动 Blender/浏览器重采、未冻结预算。记录：`q05-r04-evidence-gates-20260914-ABEYV5/REPORT.md`；后续评审与修复回归见 `q05-r04-review-20260914-C4co2W/REVIEW.md`。发版 L1 不等于独占测量或正式预算冻结；不再重做探针收编。

  2026-09-14 实测准备（未执行产品）：`identity` 完整；`preflight` `foreign_count=0`（不是独占证明）；显式 Blender `/Users/hutou/homebrew/bin/blender` 未启动。Homebrew `python3` 缺 pymupdf，切面 7 场景 refused；`apps/web/backend/.venv/bin/python` 下 13/13 `planned-not-run`。独占窗口必须用该 venv。准备记录：`~/Desktop/beian-evidence/closeout-prep-20260914-r04plan/`。

  状态：2026-09-08 已完成基于 `004ed374` / 0.22.0.0 的本地合成切片，覆盖极端切面、接近像素上限、双上传、队列串行/drain、预留与失败释放；Illustrator busy、部分取消/调灯场景为模拟或合同回归。报告在仓库外 `~/Desktop/beian-evidence/2026-09-08-r04-resource-stress/REPORT.md`，产品零改动。Blender 测量受外部负载干扰，不作为独占预算；仍缺独占 Blender/浏览器预算、复杂多图层与长循环、最大像素整链路、真实网络与宿主验证。Windows 原生异常按用户决定暂缓；R04 整项未完成。2026-09-09 第二阶段采证工具已随 PR #105 / `0.24.0.0` 发布：`scripts/resource-stress/` 提供身份/预检/矩阵/命令采样及轻量合成回归。整合修正空运行、失败/取消、无采样不得成为有效预算，以及父进程退出后的组内后代清理。只验证工具，不冻结预算；正式独占 Blender/浏览器测量未执行。

  1. 固定机器/版本/fixture 与测量方法，覆盖极端长宽比、最高允许像素、两个并发上传、Illustrator busy、Blender 单槽、重渲棚和发版排干。
  2. 先在合成隔离环境测峰值内存、磁盘/预留、排队及总耗时，记录失败/取消后的资源释放；生产场景在另获授权后取证。
  3. 根据实测决定预算是否调整；若修改，重验受影响场景及回退。**验收：矩阵、峰值、耗时、异常恢复与结论完整；32MP 是单图上限，不是进程内存上限。**

- [ ] **R08 — GLB WebP 压缩后续（#12 / #13 评审遗留）**

  状态：#12（0.31.1.11）已交付读回校验、进程内串行压缩与启动临时文件清理；以下为评审确认的后续，未开发。

  1. 收窄启动临时文件清理：当前在 `reclaimOnBoot` 前同步遍历 `DATA_DIR/mockups`（深度 ≤6）。改为只扫已知打样输出位置（`mockups/<id>/` 与 `.render-generations/.candidate-*`），或挪到服务开始监听之后的后台一次性任务，避免大量历史单拖慢启动。
  2. 串行压缩锁加超时：单次转换卡住（异常大贴图、sharp 挂起）会让后续打样一直排队。给每次压缩设上限，超时按失败处理、保留原 PNG GLB 并释放锁，补“卡住不阻塞下一单”的测试。
  3. 运维文档：写清在杭州日志里如何找 GLB 转换失败/跳过（关键字 `glb webp failed, keep original PNG GLB`、`glb webp skipped`、`render-generation <job> glb webp`；发版日志的 `GLB WebP conversion` 探针），以及如何用详情 `files[].texture_format` 抽查。只读日志，另获授权后才在杭州执行。
  4. 把压缩挪到独立子进程，使其可被中途中止（超时/取消直接杀进程、保留原 GLB）：消除 #13（0.31.1.12）残余风险——单次转换远慢于估算并越过截止时间时，出图仍可能在后续检查点超时失败。**验收：四项各自有代码/文档与测试或现场记录。**

## P2 — 新增下载与文件压缩（3 项）

- [ ] **R05 — 打样单新增净版展开图与六面平面图下载**

  状态：2026-10-09 用户进一步纠正“2D”的歧义：保留现有六面，并在“正面”左边新增“2D展开图”。该图为同一 `.ai` 稿进入 3D 之前的完整净版展开稿，可下载后按原尺寸打印、裁切并手工折成对应盒型。已实现独立展开 PDF、七标签与六面 ZIP，绑定源稿身份及完整语义几何；修复了用占位几何代替真实图文和结果 JSON 冒充关稿证据的问题。缺粘口/封口的旧几何仍拒绝，不宣称所有 AI 可导出；真实 Illustrator/打印折盒未验证。2026-10-10 随 0.31.0.0 功能代码合入新仓 [PR #1](https://github.com/tyuanww/beian/pull/1)（`5a9d79d`），并在 `0.31.1.1` 完成发版 L1（见页首）；仅进程、版本与 health 已验证，原生导出、实际打印折盒 L2 与 UAT 均未做。

  1. 在既有打样结果中提供明确的「下载 2D 平面图」入口，保留 3D 预览与下载。以清理刀线/辅助线后的印刷内容为来源，不用 GLB 截图替代平面图，不另开独立打样流程。
  2. 覆盖已支持结构的各个有效印刷面；矩形盒核对六面完整性。复用现有 `read_*` / `panel_*.png` 与补面流程，缺面明确提示，不把四面齐全冒充六面齐全，不重写 3D 流水线。
  3. 标签顺序固定为 **2D展开图 / 正面 / 反面 / 左侧 / 右侧 / 顶部 / 底部**。展开图直接来自与本次 3D 绑定的 `.ai` 净版印刷内容，保留各面原坐标、比例、方向、粘口和上下封口的完整几何；去掉刀线、折线、尺寸/制作标注等辅助内容，不删除本属印刷画面的装饰线，不拼接六张面图或截图代替。隐藏辅助线不等于丢弃其结构几何；无法可靠分离或无法证实完整性时不得标作可折盒净版。
  4. 为满足打印用途，展开图采用独立的 **原尺寸 1:1 PDF** 下载入口作为实施默认：PDF 物理尺寸和坐标须与源稿一致，不自动缩放为 A4，不截掉粘口/封口，不把页面预览分辨率当打印尺寸。界面提示打印选“实际大小 / 100%”，纸张可容纳完整展开图；自动多页拼接未纳入本次。原六面 PNG 与“下载六面 ZIP”继续保留，不能将七个标签混称七面。优先复用已保存的完整净版源件；需原生补导出时沿现有 Illustrator 宿主队列和禁杀合同，不另建打样流程。
  5. **验收：** 同单有可下载的完整净版展开 PDF 和有效单面 PNG；净版无辅助线、文字和画面完整、方向和源稿坐标一致；PDF 尺寸核对通过，代表性真稿在实际大小打印后经裁切、粘接与折叠能形成对应 3D 盒型，粘口/封口不缺失。原六面与 3D 能力不回退，源件/完整几何不足的旧单有明确处理。仅视觉原型、六面齐全或 PDF 可以打开均不等于打印折盒验收。

  依据：[成片与资产合同](docs/contracts/packaging-presentation.md)、[结构合同](docs/contracts/packaging-structure.md)；真实稿完整性共用 A02，不能以此工单代替 A02 金标。

- [ ] **R06 — 图片 / PDF 批量压缩与自动目标大小**

  状态：2026-10-09 用户确认两类 PDF 场景：多张实拍图片组成的备案文件、带公章的检测报告；每个 PDF 最终小于 10MB，压缩力度自动调整。与图片压缩合并为侧栏「文件压缩」，放在打样台下方。本地前后端已接入，采用 Sharp 与 qpdf/PDFBox 路线并加入有归属的进程树资源约束；本机 macOS 没有所需强隔离时明确不可用，不伪称能试压。**真实样本试压、章/画质验证、Windows 工具安装及现场验收未执行**；Windows RSS 为采样监控，尚无现场硬边界证据。2026-10-10 随 0.31.0.0（[PR #1](https://github.com/tyuanww/beian/pull/1)）合入，`0.31.1.1` 发版 L1 已核实（见页首）；生产机 sharp 原生模块已由离线依赖交接装入，但 qpdf/PDFBox 工具链、真实样本试压与章/画质 L2、UAT 均未做，不宣称可用。

  1. **入口与批量：** 侧栏顺序为审稿台 → 打样台 → 文件压缩 → 历史记录 → 设置。图片首版范围按 JPG/PNG/WebP，PDF 保持 PDF 输出；支持批量选择/拖入，逐文件显示进度、结果大小、节省比例和失败原因，提供单文件下载及整批 ZIP。保守初值每批 20 文件、总量 100MiB，资源限制按最终方案采证后调整；图片默认自动压缩、不新增目标输入，不把 PDF 的 10MB 套为整批 ZIP 上限。
  2. **目标大小：** PDF 默认硬上限为 `10,000,000` 字节，以实际输出字节数判定小于上限；`9,800,000` 字节仅作估算余量，首份内容与质量合格且小于硬上限的候选立即停止，不为追余量继续降质。界面无需用户调质量参数。已小于上限且通过格式/可读预检的原件按原字节直接作为结果，标明「已符合大小要求」，不能为了显示压缩率重写已达标文件。
  3. **自动策略：** 先做结构/数据流优化，超标再逐步重压缩内嵌图片，必要时降低图片分辨率；每个候选从原件生成，避免重复有损转码累积损失。限定尝试次数与资源，按实际大小选择达标且保留更高画质的候选；保留原始文件。达到预设画质底线仍超标时明确标记「未达到 10MB」，不把尝试结束当成功，也不自动拆页来冒充整份达标。
  4. **文字与公章：** 页数、顺序、页面尺寸、可选文字保持；彩色章、骑缝章、细线、条码和透明内容不能缺失，不默认灰度、黑白化或将整份矢量报告栅格化。照片内公章与独立印章/签名外观都纳入后续视觉验收，不能承诺任意文件同时大幅缩小且像素无损。
  5. **数字签名：** 已确认报告样本有数字签名结构，但未验签。结构化判定签名与修改限制，不以可见印章或空签名域代替判定。通过可读预检且低于上限时按原字节保留；达到/超过上限时拒绝重写签名或受限文件，签名状态未知也不重写。本批不提供仅保留章外观却破坏数字签名的降级；完整规则见最终执行方案。
  6. **开源借鉴方向：** 图片复用 Sharp、批量体验参考图小小；PDF 优先借鉴 Stirling-PDF 的 MIT `app/core` 压缩实现（目标大小驱动的自动调整），底层候选为 PDFBox + qpdf。qpdf 单独不是完整自动目标压缩方案。仅采用许可明确的免费开源部分并保留声明；不默认引入 Stirling 的商业 `engine`、受限 API 或其全部依赖。Java/PDFBox 运行时、Windows 安装及适配成本待后续原型验证，已交付适配与许可说明，仍不记作 Windows 兼容性已通过。
  7. **接入与验收：** Hono 仍是唯一产品边界和 `:8787` 入口；不另起 Stirling 网站/第三个服务入口。后台处理复用现有持久作业与权限边界，不让页面内存承担唯一任务事实。后续验证须分别记录大小达标、页数/内容完整、公章与小字质量、失败提示和运行环境；原型及 Windows/业务验收未完成前不宣称可上线。所有样本与输出只留私有本地证据，不提交或上传公共压缩网站。

  选型依据（2026-10-09 调研快照）：[Stirling 压缩说明](https://docs.stirlingpdf.com/Functionality/Compress/)、[MIT 范围与排除目录](https://github.com/Stirling-Tools/Stirling-PDF/blob/main/LICENSE)、[压缩实现](https://github.com/Stirling-Tools/Stirling-PDF/blob/main/app/core/src/main/java/stirling/software/SPDF/controller/api/misc/CompressController.java)、[PDFBox](https://pdfbox.apache.org/)、[qpdf 优化说明](https://qpdf.readthedocs.io/en/stable/cli.html#optimizing-file-size)、[Sharp](https://github.com/lovell/sharp)、[图小小](https://github.com/joye61/pic-smaller)。实施时固定实际复用版本与许可记录，不以动态主线链接代替依赖锁定。

- [ ] **R07 — 压缩任务与统一历史记录打通**

  状态：2026-10-09 用户明确要求历史打通。依赖 R06 的任务/产物，属于同一压缩体验的独立交付切片；服务端有权限记录检索、游标分页、压缩详情与返回恢复已完成本地集成及合成回归，真实业务验收未完成。2026-10-10 随 0.31.0.0（[PR #1](https://github.com/tyuanww/beian/pull/1)）合入，`0.31.1.1` 发版 L1 已核实；业务验收（L2/UAT）未做。

  1. 在现有历史入口增加文件压缩类型，记录创建人、时间、文件数量、图片/PDF 类型、目标大小、原始/结果大小，以及批次和逐文件状态。批量部分失败单独显示，不把整批一律标成功。 2026-10-09 用户确认补齐按品名、批次名称和批次内原文件名检索，显示命中文件；默认采用有辨识度的文件摘要命名，支持状态/类型/日期/创建人组合筛选及空结果恢复，进入详情返回后保留查询、页码和原记录位置。检索覆盖服务端有权限记录，采用每页 10 条的游标分页；旧审稿记录未保存的原文件名不能凭空检索，保留现有品名/标题检索。
  2. 上传提交成功后的处理脱离页面运行；切换 tab、关闭页面后后台继续，刷新后可找回真实状态，重复点击不创建重复处理。任务/产物持久化、重启恢复和失败重试沿用 [作业合同](docs/contracts/jobs.md)，不把浏览器局部状态当历史记录。
  3. 从历史进入可查看进度、失败原因及结果，再次单文件/整批下载；沿用现有身份、可见性和删除权限。保留已达标原件的任务也进历史，显示真实零压缩，不伪造节省比例；源文件与压缩副本清晰区分。
  4. **验收：** 新页面与历史显示一致，离页/刷新不丢任务，持久结果可重复下载，处理中/部分失败/目标未达成可区分，访问权限与现有历史一致。过期或缺失产物明确提示，不提供失效下载；沿现有长期保存及同权限手动删除策略，不新增自动清理；本轮不删除文件。

## P2 — 采用、资产与合规（3 项）

- [ ] **B01 — 审稿金标与采用止损**

  状态：既有能力待业务验收。2026-10-09 将本会话已整理的刘籽烨反馈纳入 B01.4/.5：同屏核对体验与实际误报仍待落实，不以已有浮窗、缩放、定位或解释能力证明她已验收。本轮落地方案已批准。2026-10-09 A1 已完成右栏代码并由 E 本地集成（A `deaa19a` → E `e109fb8`）；R05–R07 已完成前后端本地集成；B01.5 的 D/A5 已由 Codex 实现并本地集成，真实稿未验证。

  1. 与刘籽烨建立至少一组已知漏标、误报、待人工确认金标，可引用 A04，但保留各自验收目标。
  2. 完成使用辅导并记录实际开单方式、是否仍需左右分屏、第二周是否主动开单；时间从约定试用起点计算，不用自然日期经过代替观察。
  3. 根据真实使用结果记录继续/整改/止损决定。**验收：金标和采用结论齐全；若持续分屏或第二周不主动开单，停止“生产级远程工作台”叙事，评估飞书报告路线。**
  4. **B01.4 · 审稿界面反馈：** 用户明确将现有自由浮窗替换为固定在右侧的侧边栏，画布使用剩余空间；按用户最新交互采用默认 448px（可调 320–560px，受可用空间约束），可收起、独立滚动，同屏看稿和疑点；点问题能定位放大，减少大圈/编号遮挡；解释简短直接。2026-10-09 用户认可补充只看待确认、疑点目录、下一待确认、长文本布局及离页返回恢复处理位置；A1 已实现产品右栏、键盘调宽、目录/筛选/连续核对、按用户/任务/版本恢复字段和备注、保存失败提示与签字/对红前草稿保护；缩放后钉保持屏幕尺寸。E 已同步 DESIGN/界面与审稿合同。Mac 本地 UI 类型/构建通过，UI 单测 376 项通过，审稿/上传合成交互 21 项通过，后续窄屏/大字号/标记调整的 10 项核对页回归通过；320/390/736/1024/1440/1600 宽度、深色 28px 与长文本为合成证据。未跑真实稿、Windows、完整 L0/质量门或 UAT，未发布；仍保留以下业务验收。**验收：刘籽烨能在一个工作界面连续核对、处理疑点，无需另开左右分屏。**
  5. **B01.5 · 误报/漏标反馈：** 收集她认为「实际没错却报错」及漏标的具体样本，与 B01.1/A04 共用人工真值；区分识别、字段对应、规则判断和展示解释的问题，按复现证据修正，不先重写审核引擎。用户确认所给 PDF 在 Illustrator 内可复制正常中文、修改内容；其标准 PDF 文字层为空且保留 Illustrator 编辑数据，因此新增原生文字提取候选支路，校验可见性、画板坐标与 PDF 显示一致性后参与核对，不将“矢量 PDF”直接等同于普通可提字 PDF。隐藏/过期/映射不明的内容不自动采信，混合图像区域保留 OCR，仍由人终审；与打样共用 Illustrator 宿主、队列和禁杀合同，不另起原生应用控制链。D 已接入同一 JSX/宿主、FIFO 单槽及独立关闭记录；使用源稿与导出稿的受限渲染比对、可见性/字体/坐标和唯一文字对应证据，在 OCR 合并前纠正读法，再走原有 verify_fields。A5 展示原稿/OCR 来源及冲突，不改人工决定。合成 PDF 已证明指定误读被纠正而确认单真实差异仍检出；未取得真实 Illustrator/用户稿金标改善证据。多页不匹配、页面旋转元数据、遮挡/剪裁、字体或渲染无法证明时保留识别回退，不宣称所有可编辑 PDF 都会采用原生文字。**验收：逐例结论与原因可追溯，修复覆盖受影响样本，人工终审和签字门不回退。**

  早期业务需求补录（本会话原始需求盘点；均未见完整业务闭环证据，待确认/排期，不算本轮压缩范围）：

  | 子项 | 历史需求 | 已知基础与剩余工作 |
  |---|---|---|
  | B01.H1 | 不同规格稿件对比 | 已有底层对比能力不等于网页产品完成；仍需明确两份输入、允许的规格差异、核对规则及结果入口。与 A04 同一稿件改版后的对红验收分开 |
  | B01.H2 | 营业执照与 Excel 信息核对 | 需明确执照输入、待核字段、人工结论与报告；不按已有 Excel↔PDF 审稿能力标完成 |
  | B01.H3 | 检测报告结论整理 | 需明确应提取的项目/结论、整理格式和人工复核；仅压缩 PDF（R06）不等于报告内容分析完成 |

- [ ] **B02 — 真稿出境书面许可**

  状态：2026-09-08 用户确认已有相关稿件交由百度 OCR / MiniMax 处理的书面许可；私有证据路径与适用范围仍未记录。2026-09-14 按文件名检索未见可记路径。用户决定放下、不追路径，主题不勾。未读原文或真稿。放下不等于许可已归档；A01–A04 / Q06 真实稿若需百度 OCR、MiniMax 或其他出境处理，仍须先补路径与范围，否则只做本机或停止。

  1. 核实适用稿件、权利人、拟用百度 OCR / MiniMax 的处理范围与是否已有书面批准，不读取或传播真稿来证明许可。
  2. 已有许可则记录私有证据位置及适用范围；缺失则提交具体外部处理用途供批准；拒绝时选择本机 OCR 或停止对应处理。
  3. 在相关真实调用前逐项匹配许可范围。**验收：实际处理有适用批准，或明确采用本地/停止方案；真稿、人工真值、输出不进 Git 或对外模型上下文。**

- [ ] **B03 — 公司仓 / 第二管理员与主分支保护**

  状态：2026-09-14 核实为 `weiweity` 个人公仓（`visibility=public`），不是旧记录中的私仓；管理员/协作者列表仅 `weiweity` 一人。用户批准后已启用 main 传统保护，15 项回读核对通过：必须 PR，`quality` / `windows-powershell-contract` 均绑定 GitHub Actions app `15368`，strict 同步 main，管理员受约束，禁止强推/删除，线性历史及评审对话解决；暂不要求第二人批准（0 人），不设绕过名单。main SHA 未变，未借配置验证执行合并/发布或破坏性推送。仓库外证据批次：`protection-branches-20260914-n7eXoe`。首次两次请求因 API 字段组合/个人仓不接受组织字段被拒，修正请求表达后成功，未降低门禁。用户本轮确认归属/第二管理员已有安排；2026-09-14 决定暂缓归属，不记录第二管理员账号，不邀请、不迁移。B03 因移交细节未记仍开放，main 保护维持。

  2026-09-14T13:57Z 只读回读与上述事实一致：collaborators 仍仅 `weiweity`，invitations 0，teams 0，保护字段未变。原始 JSON：`closeout-prep-20260914-r04plan/github-*.json`。未邀请、未迁移、未改保护。

  2026-10-10 迁移更新：原仓 `weiweity/beian` 随账号封禁不可访问，上述保护随之失效。新仓 `tyuanww/beian`（公开）只读核实 `GET branches/main/protection` 返回 404 `Branch not protected`：**当前 main 没有任何保护**，任何有写权限的人或令牌可直接 push main，从而直接触发杭州生产发版。需按原 15 项重建：必须 PR，必需检查 `quality` / `windows-powershell-contract`（绑定 GitHub Actions app），strict、管理员受约束、禁止强推/删除、线性历史、对话解决。重建属于仓库设置变更，需用户授权；完成后只读回读核对，不用破坏性 push 试验。

  1. 复用上述仓库归属、管理员与主分支保护核实记录；聚焦仍待确认的公司归属、第二管理员与移交安排。
  2. 由用户确认组织仓迁移或第二管理员方案；具体设置变更、邀请人员或迁移仓库按对应授权落实，不重复启用已生效的 main 保护。
  3. 保护设置已完成只读回读；后续如获准变更，再只读复核有效设置与权限，不用破坏性 push 试验。**验收：归属/移交、管理人员、有效保护证据齐全；套餐不支持时保留明确缺口，脚本不冒充不可绕过保护。**

## P3 — 独立后续（11 项）

- [ ] **F12 — 飞书签字通知只数 `task.hits`，忽略 `hits_v2`**

  状态：未开始。`apps/web/server/src/notify.ts` 的 `taskCompleteHeadline` / `taskCompleteText` 只读 `task.hits`；有 `hits_v2` 的任务（`tasks.ts` 摘要已优先用 `hits_v2`）在缺 `complete_kind` 时可能把标题判错、改稿条数和字段列表也不准。设置 PR 合入后单独做一个小修复：与 `tasks.ts` 一样优先 `hits_v2`，非空时用它，否则回落 `hits`。**验收：只有 `hits_v2` 含改稿项的任务，飞书标题为「已退回」且条数正确，有单测。**

- [ ] **F11 — 与飞书告警一起做（版本号届时顺延）：发送测试可发给已配置接收人（产品哥建议）**

  状态：未开始。0.31.1.14 起「发送测试」只对管理员开放，发给当前登录者的 `open_id`；接收人 `FEISHU_OPEN_ID` 为空时会被设成当前登录者。产品哥建议与飞书告警一起做，版本号届时顺延：

  1. 发送测试可直接发给已配置接收人 `FEISHU_OPEN_ID`，不改接收人。
  2. 接收人为空时，在按钮旁提示「接收人还没填，测试后会设成你自己」，或禁用按钮。
  3. **验收：已配置接收人时测试消息到达该接收人且 `FEISHU_OPEN_ID` 不变；为空时界面有提示或按钮禁用，并有测试覆盖。**

- [ ] **F10 — 任务/作业失败报错是否向非管理员带出本机路径（部分解决）**

  已做（0.31.1.14，`fix/settings-admin-only`）：`/api/tasks` 列表与详情的 `job_error` / `error` 对非管理员去目录留文件名，管理员看原文；飞书失败通知（`fireTaskNotify`、`fireMockupNotify`）同样脱敏，兜底文案「任务失败，原文已隐藏，请到后台查看（单号 …）」。规则见 `docs/contracts/identity-settings.md`（`apps/web/server/src/pathRedact.ts`，测试 `path-redact.test.ts`、`job-error-redact.test.ts`）。打样单列表 / 详情（`publicMockupSummaryFields`、`publicRenderMutation`）对非管理员在原 `publicMockupError` 之后叠加脱敏 + 兜底（单号 `job.id`，测试 `mockup-error-guard.test.ts`），管理员照旧只走 `publicMockupError`。

  明确不在本次范围、未审计（可能仍带出本机路径）：
  - `apps/web/server/src/index.ts:424` 全局错误处理对 4xx 原样返回 `err.message` 作 `detail`。
  - `notifyIllustratorWatchdog`（`notify.ts:247`，`jobs.ts:959`、`nativeTextJobs.ts:176` 调用）的飞书告警文案。
  - `apps/web/server/src/mockup.ts:595` `print_faces_repair.error` 未接兜底：来源是白名单文案，不含原始报错。
  - 已知规则缺口：斜杠写法只剩末尾一截文件名含空格或中文标点时露出后半截文件名（`/Users/bob/my docs/a b.pdf` → `本机路径 b.pdf`，`/home/bob/a，b.pdf` → `本机路径，b.pdf`）；目录名已不漏。
  - 已知规则缺口：网址里百分号编码的用户名密码（`http://bob%3Apw%40x/`）原样输出，不拦。
  - 已知规则缺口（不拦）：全角斜杠 `／`、`＼`、`∖` 不当分隔符；超长 UTF-8 `%c0%af`、HTML 实体 `&#47;` 不解码；路径被换行断开时只认换行前半截。
  - 已知规则缺口（不拦）：`ftp://` 等非 http(s) 网址按普通路径处理，输出 `ftp:本机路径`。
  - 已知取舍（不拦）：8000 字截断落在占位词中间时留半截占位词；打样单报错（含兜底后）只留前 80 字。
  - 已知取舍：渲染代际提交结果（`publicMutationResult*`，`jobs.ts`）拿不到角色，`mutation.error` 一律按非管理员规则输出，管理员在这一处也看不到原文。
  - 已知副作用：`%2F` / `%5C`（含 `%252F` 等多重编码）整条报错一起解码，非路径文字也会变（如 `进度 50%2F100` → `进度 50/100`，网址里的 `%2F` 同样被解开）。
  - 已知取舍：Windows/UNC 末段无扩展名、空格后的词以扩展名结尾时合成一个文件名（`C:\x\dir see.log` → `dir see.log`），只认一个空格。
  - 已知取舍：反斜杠根路径只要有一段目录名不少于 2 个字符就脱敏；兜底再拦「反斜杠 + 至少 2 个字母」（`C:\Documents and Settings\bob` 这类空格过多的目录），所以报错里字面的 `\nfoo` 这类转义串会整条隐藏；单字母 `\n`、`\t` 不受影响。
  - 已知取舍：查询参数名为 `password` / `pw` / `token` / `secret` / `key` 等（含 `api_key`、`access_token`）时整条隐藏，即使值无害；`monkey`、`keyword`、`tokens_left` 不算。
  - 已知规则缺口（不拦）：网址外的凭据写法（`password=hunter2`、`token: xxx`、`"password":"x"`）。原因：`Unexpected token: }`、`missing key: foo` 这类常见报错会被大量误隐藏；等报错分级上错误码后统一处理。
  - 已知规则缺口（不拦）：网址 fragment（`#access_token=…`）和网址路径里的令牌（`/token/abc123`）。
  - 已知规则缺口（不拦）：斜杠写法目录名含空格时露出最后一截（`/Users/bob/Google Drive` 这类，空格后只剩一段时）。`/Users/`、`/home/` 后的用户名段已改为含空格时一直替换到下一个 `/` 或行尾（`/Users/bob smith` → `本机路径`）；取舍：同一行后面没有 `/` 时，用户名后面的文字一起并掉（`读取 /Users/bob smith 失败` → `读取 本机路径`）。
  - 已知规则缺口（不拦）：打样单 `读取 D:\a b\c 失败` 输出 `读取 本机稿件 b\c 失败`，残留 `b\c`（单字母目录段，不触发反斜杠兜底）。
  - 已知取舍（不拦）：`共享盘\\` 会被改写，任务链输出 `共享盘 本机路径`，打样单输出 `共享盘本机稿件`（`\\` 被当成 UNC 起点）；兜底测试只锁了它不触发整条隐藏。
  - 已知取舍（不拦）：打样单 `bearer 字段为空` 被 `publicMockupError` 整条换成「打样失败，请让管理员在本机检查详细原因」（原有 `Bearer\s+` 规则，管理员同样）。
  - 已知规则缺口（不拦）：`postgres://…` 等非 http(s) 连接串输出成 `postgres:本机路径`。
  - 已知取舍：兜底「反斜杠 + 非 ASCII」与「非 ASCII 紧贴反斜杠再接内容」会把中文紧贴的转义（`换行\n`）整条隐藏；`共享盘\\` 这类后面是空白或反斜杠的不算。
  - 已知取舍：`Bearer` / `Basic` 后含数字或符号、不少于 6 字符的值拦；`Basic` 后另拦至少 8 位、首字母外有大写或含数字 / `+` / `/` / `=` 的 base64 串（`Basic dXNlcjpwYXNz` 拦，`Basic settings`、`Basic Settings` 不拦）；全小写无数字符号的 `Basic` 串、纯字母 `Bearer abcdefgh` 不拦；`Authorization` 任意大小写都拦。
  - 已知取舍：兜底拦单个盘符字母 + 冒号紧贴「本机稿件 / 本机路径」后还有内容（`D:本机稿件 张三/报价`）；`open:本机稿件` 这类单词加冒号不算。选兜底而非调换打样链顺序，以免改动已有打样文案。
  - 已知规则缺口（不拦）：凭据词与前缀无分隔符连写的参数名（`?apikey=1`、`?accesstoken=`）不触发兜底。
  - 已知取舍：网址路径里出现 `/Users/`、`/home/`、`/root/`、`/var/folders/`、`/private/var/` 时，即使是公开网站也会被替换（`https://example.com/Users/list` → `https://example.com/本机路径`），宁可误伤也不漏。
  - `apps/web/backend` worker 输出与其他 HTTP `detail` 未逐一盘点。

  原状态：2026-10-11 设置接口按角色收紧（`fix/settings-role-trim`）自查时发现，不在该 PR 范围内，未审计。`/api/settings` 已对非管理员去掉本机路径，但审稿任务、打样、出图、压缩等作业失败时返回给前端的报错文案（HTTP `detail`、任务/作业的 error/reason 字段、worker stderr 摘要）可能原样带出 `C:\`、`/Users/`、`/home/`、数据目录（`WB_DATA_DIR`）、Python 或 Blender/Illustrator 路径。

  1. 盘点 server 中所有把作业错误、子进程 stderr 或异常 message 回传给客户端的位置（含 `apps/web/backend` worker 输出）。
  2. 对 reviewer/viewer 做路径脱敏（或只给通用文案），管理员保留原文；脱敏规则与 `settings.ts` 的 `redact` 对齐。
  3. **验收：三种角色的失败用例测试中，非管理员响应序列化后不含上述路径模式；管理员报错不变。**

- [ ] **F09 — Node 20 下的测试 glob 兼容与 CI 覆盖**

  状态：生产 Windows 跑 Node 20 LTS，但 `.github/workflows/quality.yml` 里完整 L0（`npm test`、`npm run test:quality`、`npm run typecheck`）只在 ubuntu + Node 22 上跑；Node 20 只用于 Windows 的 GLB WebP probe。2026-10-11 在 Mac 上用 `npx -p node@20`（v20.20.2）手动跑过一次 server `tsx --test src/*.test.ts`：900 项，通过 898，失败 0，跳过 2。`src/*.test.ts` 由 `sh` 展开，没有依赖 Node 22 的 `--test` 内置 glob；UI vitest、pytest、quality 没有在 Node 20 下验证过。

  1. 在 CI 加一条 Node 20 的 server L0 job（或 matrix），至少跑 `npm test -w beian-server`。
  2. 约定测试脚本不要用依赖 Node 22 的 `node --test` 引号 glob（Windows `cmd` 不会展开 `*`），新增脚本要在 Windows + Node 20 上跑一次。
  3. **验收：CI 上同一 SHA 的 Node 20 与 Node 22 server 测试数量和结果一致。**

- [ ] **F01 — 退役核对原型清理（独立 PR）**

  状态：0.22.1.0 已清理退役 `reviewSplit.ts` 及其自测（静态引用、行为、入口和生产边界已审计），现行 `reviewDock` / `canvasZoom` 保留。2026-09-15 静态盘点见仓库外 `~/Desktop/beian-evidence/f01-ocr-smoke-inventory-20260915/REPORT.md`：现行 OCR 主链与发版 smoke 在用；`ocr_zone_boost.py` / `ocr_ensemble.py` / `create_smoke_fixture.jsx` 仓内无调用但仍保留（仓库外入口未确认）。未删文件、未改复杂度基线。整项仍开放。

  1. 按 [ADR-006](docs/adr-006-continuous-complexity-governance.md) 获取静态引用、行为测试、运行入口、生产边界四类证据；动态/仓库外入口未确认就保留。
  2. 给出精确文件清单、影响与回滚方式，在批准范围内逐批删除并同步缩小质量基线，不混入 3D/Windows 发版功能。
  3. 验证受影响成功/失败语义与质量门；明确 `/ship` 后才出独立 PR。**验收：删除有四类证据，基线不扩张，相关回归通过。**

- [ ] **F02 — Tunnel / 服务掉线告警**

  用户确认由本人接收。2026-09-14 选定渠道为**独立飞书 bot**（`--as bot`），托管目标为杭州 Windows 计划任务。经明确授权，F02 transport 一次性 `allowRealSend=true` 向本人发出测试故障和测试恢复，用户均确认飞书已收到。未走产品 `FEISHU_*`。已增加杭州托管入口 `scripts/monitoring/host.mjs` 与安装器 `scripts/windows/install-monitor.ps1`（SYSTEM、`beian-monitor-local`、不停生产服务、不改 Illustrator、不由 `release.ps1` 自动安装）。杭州 identity 在 `C:\supply\data\monitor-identity.json`：`allowRealSend=true`，独立 bot `appId=cli_aa042a6e0779dbd5`，`receiveId=ou_5c0460f3d3bb88bfc507b5cc024b8dfc`。BOM 导致的首次退出码 2 已在 0.30.1.0 修掉。2026-09-15 杭州来源测试消息用户确认「有了」。未停 8787/cloudflared，真实掉线/恢复现场仍开放。证据：`f02-test-send.json`、`f02-test-recovery.json`。

  本轮交付独立 transport：`scripts/monitoring/delivery/feishu-bot-transport.mjs`。须显式绝对 `cliPath`、`ou_` 接收人和 `exec`，或 HTTP `appId`/`appSecret`；`createLarkCliExec()` 默认 `allowRealSend=false`。合成测试覆盖 argv、拒绝环境变量、exit 10/丢失确认/缺二进制与队列接线。杭州托管与测试消息见上段；不以停生产服务测告警。整项仍开放。

  配置装载切片已随 PR #112 / `0.27.0.0` 完成发版 L1：显式绝对路径的非敏感策略装载复用既有 normalizer；显式 null、空来源数组、未知/禁止字段及非法范围均失败关闭。

  状态：本地判断核心、探测、投递、runner 与杭州 host 已随 0.24.0.0–0.30.1.0 发布。进程模型不证明断电耐久。不以主动停 8787/cloudflared 测告警。整项仍开放。

  1. 确认监控对象 `beian-server-8787`、cloudflared 的可读状态、告警接收人/渠道、去抖与恢复规则。
  2. 在隔离环境实现故障/恢复判断、重复抑制及消息草稿，用模拟故障验证，不以主动停生产服务测告警。
  3. 经对应部署/真实消息授权后接入并验证一轮通知与恢复。**验收：检测、发送及恢复证据齐全；Illustrator Agent 保持交互桌面，不改 Session 0 服务。**

- [ ] **F03 — SQLite / 通用异步队列评估**

  状态：条件性任务，暂不启动。2026-09-15 只读探查：现有作业仍是单进程 dispatcher + `job.json` 原子改名 + 代际 `index.jsonl`；章程/ADR-004 禁止 SQLite/通用队列。未见可复现的 JSON 一致性损坏或吞吐瓶颈测量（没有生产作业堆积样本、没有失败复现）。保持暂缓，不立项。仓库外记录：`~/Desktop/beian-evidence/a-sample-intake-20260915/f03-json-jobs-readonly-20260915.md`。

  1. 仅在现有 JSON 作业合同出现可复现一致性/吞吐瓶颈时收集最小复现与测量；没有证据就保持暂缓。
  2. 对比修复现有合同、SQLite、通用队列的收益/迁移成本、恢复与运维要求，形成决策稿。
  3. 记录继续现有方案或另立实施项目。**验收：评估有事实与决定；评估完成不代表存储迁移已实施。**

- [ ] **F06 — 仓库迁移收尾（tyuanww/beian）**

  状态：2026-10-10 已完成：新仓推送、启用 Actions、杭州 runner 以 `hangzhou-windows` / 标签 `hangzhou` 重新注册、服务账号从 `NETWORK SERVICE` 改为 LocalSystem、`D:\beian` 的 `origin` 改指新仓，`0.31.1.1` 发版 L1 已核实。分支保护见 B03。下列项未核实或未做，详见 [仓库迁移操作指南](docs/howto-repo-migration.md)。

  1. 重建并只读核对 Actions secrets/variables（`hangzhou-release` 当前只用内置 `GITHUB_TOKEN`；如另有 secret 逐一列清）、deploy key、webhook、Environments、Actions 权限（默认 `GITHUB_TOKEN` 只读）和 fork PR 审批策略。
  2. 轮换或作废原仓相关凭据：旧 runner 注册/PAT、`gh` 登录令牌、可能在 `D:\beian` 或 Mac 上缓存的旧 remote 凭据；确认杭州 `C:\supply\data` 的业务密钥不受仓库迁移影响。
  3. 建立 GitHub 之外的只读镜像（例如定期 `git push --mirror` 到第二托管或离线 bundle），避免再次因单账号封禁失去仓库与 PR/run 证据。
  4. **验收：** 设置与凭据清单逐项有回读证据；镜像可还原到指定 SHA；不以“发版成功”代替这些核对。

- [ ] **F07 — Linux Rollup 原生包缺失（npm/cli#4828）**

  状态：`package-lock.json` 由 Mac 生成，只含 `@rollup/rollup-darwin-arm64`，缺 Linux/Windows 原生包条目。Windows 发版已在 staging 中按 rollup 声明版本 `npm pack` 补齐；GitHub `quality` job 用 `npm install --no-save` 临时修复；WSL staging 等新的 Linux 部署需手动补装。

  1. 评估在干净环境重新生成跨平台完整的 lock（或 `npm install --os/--cpu` 补齐条目），比较依赖图变化范围；变化会触发一次离线依赖交接。
  2. 若采纳，删除各处临时修复并让 `installed` 校验覆盖原生包。**验收：** Linux/Windows 干净 `npm ci` 无需手动补装即可构建 UI；或记录不修的理由。

- [ ] **F08 — WSL2 staging 副本与 Linux health 文案**

  状态：杭州机 WSL2 Ubuntu 上有一份预发副本（`beian-wsl.service`、`127.0.0.1:18787`、`/opt/beian`、数据 `/srv/beian-data`），经 Tailscale 由 root 管理，操作见 [WSL staging 操作指南](docs/howto-wsl-staging.md)。计划的 Cloudflare 主机名 `beian-staging.jianghua.site`（挂在现有远程管理隧道 `customer-agent-hangzhou` 上）尚未添加。Linux 上 Illustrator/Blender 不可用，但 health 的 Illustrator 状态走非 win32 分支，返回“macOS 继续使用现有 AppleScript 桥”，`ready=true`，会误导。

  1. 修正 `apps/web/server/src/illustratorAgent.ts` 非 win32 分支：区分 darwin 与 Linux，Linux 返回 `required=true`/`ready=false` 或明确“本平台不支持打样”，并让 UI 不对 staging 用户开放打样入口。
  2. 经 DNS/隧道授权后再添加 staging 主机名，并要求登录，不得使用显示名裸登录；staging 的发布方式、数据隔离和是否保留在 TODOS 中说明。
  3. **验收：** Linux health 不再声称 AppleScript；staging 访问有身份控制；不以 staging health 作为生产证据。

- [ ] **F05 — 飞书机器人收文件回报告**

  状态：备选路线，须业务选择后单独立项。

  1. 根据 B01 采用结果确认是否启用，明确接收文件、报告内容、用户范围、权限与费用。
  2. 需求获准后设计收件→处理→回报告流程、失败回执和真实稿许可边界，拆可独立交付的实现片；保留当前网页入口。
  3. 在真实消息/稿件处理授权后完成 UAT。**验收：权限、费用、成功/失败回执与人工使用结论齐全；未选定路线时继续暂缓。**

## 已完成工作与工程细则

- **F04 审稿缩放性能已结案（2026-09-08）**：Claude 本机合成测量未发现明确瓶颈，产品零改动；缩放/拖动合同断言、57 项单测及 9 项浏览器回归据交付记录通过。原始测量报告已核对，位于仓库外 `~/Desktop/beian-evidence/2026-09-08-f04-review-zoom/`。仅覆盖所测 Chromium headless 合成页面；不代表杭州、真实稿、GPU 上屏或其他浏览器验收，不再派发无证据优化。

- 版本变更历史：[CHANGELOG.md](CHANGELOG.md)；版本条目不等于发布证明。
- 发布证据：对应 closeout 的 merge SHA、可信 run 与当时 health；规则见 [发布合同](docs/contracts/release.md)。
- 当前产品与启动：[README.md](README.md)；视觉决策：[DESIGN.md](DESIGN.md)、[界面约束](docs/contracts/interface.md)。
- 打样宿主/结构：[结构合同](docs/contracts/packaging-structure.md)；成片/下载：[成片合同](docs/contracts/packaging-presentation.md)。
- 身份/设置/推送：[身份与设置合同](docs/contracts/identity-settings.md)；模块边界：[架构合同](docs/contracts/architecture.md)。
- 2026-09-02 现场数据：[历史诊断](docs/diagnoses/2026-09-02-mockup-illustrator.md)，不代表持续监控或当前验收。
- 核对页提交失败提示目前只按 HTTP 状态 + 重读任务判断（`reviewFlat.ts` `submitFailureText`），服务端 `/complete` 只回 status + detail 文本。等后端第 1 项（结构化错误码）和第 6 项（退回至少一条有错的校验/错误码）上线后，改成按错误码映射，并补「至少标一条有错才能退回」文案与 e2e（第 6 项未批，本 PR 不做）。
