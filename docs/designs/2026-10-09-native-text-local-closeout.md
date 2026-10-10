# D / A5 原生文字本地交付记录

2026-10-09。用户明确“这次由 Codex 接手 D、A5 和 E”，由同一主 agent 完成代码、合成验证和本地集成。本记录继承[上一批回执](2026-10-09-batch-local-closeout.md)，未完成事项仍只维护在 [TODOS](../../TODOS.md)。这是 Code 与本地测试证据，不是原生可行性或真实稿验收。

## 代码范围

输入集成基线 `a33cac01339f255efc3c1251b8427d232f3b2907`。A5 来源提交 `9465e6db3fcd81c556d7713da8741d92b40f7bcd`，本地集成为 `940a66e0346f37c72bfd431a738bbe2ca9b79cff`。D 前两提交 `acb637e7614461004ae6fa4e53dbf97181de5371`、`a067cbe366ab9fa78a1005f8e99ca263e72db115`，本地集成为 `d680735800aece61ef2f6736b307d0609930eec4`、`033ce45467f71258704dd1cdef05a6c9d4a2402b`。最终审计补丁与集成产品 HEAD 见下方完成回执。

- D 复用唯一 illustrator_worker / export_structure JSX / export_close，以及 Windows 既有 Agent。协议继续 beian.illustrator.export/2，新 request_kind=native_text，没有新增宿主入口。
- 原生前置与结构/净版共享 FIFO Illustrator 单槽；未派发排队超过 120 秒继续 OCR。已派发任务关闭未确认时保留占槽，审稿可回退 OCR，但不能启动第二个 native 或删除在用源副本。运行者与关闭证据都确认后才解围栏；晚到结果不替换已选择的 OCR。
- 标准 PDF 文字层维持原优先级。原生文字必须通过源身份、独立关稿、页面/尺寸、可见稿面渲染、导出文字位置与唯一 OCR 框对应，才修正相应 OCR；图片区域继续保留。纠正结果进入原有 verify_fields，不直接改人工 decision，不回写旧单结论。
- 完整原稿/OCR 读法先原子写私有 fusion-audit.json，写入失败或源变则不采用。公共详情仅安全投影阶段/中文原因；字段只投影可信且相关的来源证据，不暴露 PID、hash 或路径。合并读法超公共上限时省略卡片，私有完整审计保留。
- A5 右栏展示“已参考原稿文字 / 文字来源有冲突 / 原稿文字未采用”，展开分别查看两种读法。旧单无证据不补卡片，未知版本不报成功；沿原定位、人工决定、hits_v2 和签字/对红门。窄屏、深色、大字号和长文有合成交互覆盖。

公共 schema 与失败语义见[审稿合同](../contracts/review.md)，持久化/槽位见[作业合同](../contracts/jobs.md)，宿主见[结构合同](../contracts/packaging-structure.md)。未改 B 的 unfolded_print/print_faces_zip 公共语义、C 压缩/历史接口、VERSION、CHANGELOG、CI 或 AGENTS。

## 本地证据

环境 macOS / Node 24.19.0 / npm 11.17.0。Python 使用 B 工作树已有虚拟环境；测试生成合成 PDF，使用 PyMuPDF 和 mock 宿主，不启动真实 OCR / Illustrator / Blender。浏览器使用已有构建 artifact-only 全 API 拦截，无监听端口；HTTP 使用 Hono app.request。

| 范围 | 命令 / 结果 |
|---|---|
| D 服务端全套 | `npm run test -w beian-server`：812 passed，1 skipped，exit 0 |
| D Python 最终 | `<B .venv/bin/python> -m pytest -q`：1334 passed、9 skipped、10 deselected，exit 0，216.42 秒 |
| A UI 全套 | `npm run test -w beian-ui`：384 passed / 87 suites，exit 0 |
| E 类型及构建 | `npm run typecheck`：server 类型 + UI build，exit 0；原大 chunk 提示保留 |
| E HTTP 联合 | tsx --test native-text-jobs.test.ts、review-http.test.ts、spa-http.test.ts：66 passed，exit 0 |
| E 浏览器联合 | native-evidence、review-workspace、batch-features、history-bulk-delete、mockup-board：41 passed，exit 0 |

浏览器完整调用：`PLAYWRIGHT_ARTIFACT_ONLY=1 npm run test:e2e -w beian-ui -- e2e/native-evidence.spec.ts e2e/review-workspace.spec.ts e2e/batch-features.spec.ts e2e/history-bulk-delete.spec.ts e2e/mockup-board.spec.ts`，另以 --output 将截图写仓外。HTTP 调用为 `WB_PYTHON=<既有 B .venv/bin/python> node_modules/.bin/tsx --test apps/web/server/src/native-text-jobs.test.ts apps/web/server/src/review-http.test.ts apps/web/server/src/spa-http.test.ts`。

D 最终后端树与 E 相同，A 最终 UI 树与 E 相同；源代码未变的已通过证据按 TESTING 复用，未重复构建/跑相同测试。服务端 skip 和 Python skip/deselect 的具体原因以仓外完整日志为准，未计为通过；真实稿/native 标记未启用。新增原生测试涵盖可见对应、真差异仍保留、原人工 pending、混合图片区域、坏字体/遮挡/旋转/旧源、独立关闭、未知围栏、FIFO、排队回退、证据持久化失败。

仓外完整回执及日志：本会话 `grok-handoff-20261009/v2/D-codex-native-text-REPORT.md`、`E-codex-integrate-REPORT.md`、`evidence-D-A5/`。这些不是仓内产品依赖。

## 实际限制与阶段边界

逐像素相同是保守条件；真实 Illustrator 重导出的字体、渲染或页面差异可能导致 OCR 回退。旋转元数据、遮挡/剪裁、缺字体及无法唯一匹配的对象不采用，本地通过不证明用户稿件的采用率或误报改善。公共来源卡片有长度边界，完整审计仅留私有任务目录。

未运行用户提供 PDF、真实 OCR / Illustrator / Blender、Windows Agent 原生现场、打印折盒、金标 L2、刘籽烨 UAT。R06 真实文件是否压到 10MB 以下且章与小字清晰、Windows 压缩工具和容器行为仍待验证。未执行本批完整 /ship 质量门、PR CI、发版 L1 或生产发布。没有推送、PR、合 main 或新增外部消息。

依赖：本阶段未新增依赖。CodeGraph 索引不可用，按定点搜索继续；未安装/重建。Ant Design 只读包装器版本限制未绕过；UI 使用项目既有组件、类型与合成交互验证。历史工具限制不被本记录消除。

## 完成回执

D 最终补丁 `322fd8bd59eecb93eb53196357321c13e37ea33b`；E 对应产品 HEAD `a416e14a410ff8598d10e81aa73125f3bda51c08`。E 与 D 后端文件树、E 与 A UI 文件树分别经 git diff --exit-code 确认相同。随后仅提交本回执及 DESIGN/TODOS/相关合同，不改产品源码。相对链接及 git diff --check 通过。
