# 审稿与人工判断合同

本文件保存原 AGENTS 的对应工程合同，仅在涉及本主题时读取。产品行为不构成执行作业、发送消息或操作生产的授权。日期与验收状态是记录时快照，当前结论须绑定本次证据。路径除链接外均相对仓库根。

## 核对页与人工判断

核对页优先读服务端生成的 SVG 核对面，生成或浏览器加载失败自动退高清 PNG；SVG worker 必须独立进程、限时、限输出，失败写简短 problem/cause/fix。框在 `pinBox.ts`：有 bbox 才画真框，钉在框中心，不编造顶排钉。关掉「对照」时，默认只画**当前字段**的钉和框。开着时见「对照」。隐藏钉只藏当前圆圈，框仍在；显示框单独开关；拖动画布暂时藏框。永不恢复全页散钉。缩放在 `canvasZoom.ts`：初始 1× 输出 `transform: none`，非初始状态才用 CSS `transform` 1–6×；`will-change` 只在实际平移时短暂启用，拖动走 rAF 且禁止 img 原生拖拽，不上 OpenSeadragon。核对栏由 `ReviewWorkspace.tsx` 放在稿件右侧，固定 320px、不能调宽（0.31.1.16 A 通铺）：视口 ≥1440 常驻，720–1439 默认收起、展开为 320px 浮层，<720 不显示右栏。独立滚动、可收起。全屏下栏和下拉弹层留在全屏根节点内。疑点目录和待确认导航置顶；当前字段先用跟随外观字号的正文写「核对要点」（lead / because / ask），结论用「一致 1｜有错 2｜忽略 3」按钮，Excel 应印与稿上读到两列，「查看全部」才出命中比；包装定位写「没找到位置，请看整页」（系统文案不用「我」「你」，一行提示句末不带「。」，规则见 DESIGN.md「文案与状态」；because / ask 为空时不渲染，只剩一行时只出「这些字没读全，请核对」；旧单落盘的 JSON 不改：服务端在详情返回 `hits` / `hits_v2` 时（`publicTask` → `legacyCopy.ts`），按原句精确替换四句已知旧 evidence，即两句以「我」自称的净含量 / 毫升和条码提示，以及两句带句末「。」的净含量&条形码提示；其他文本原样返回）；这单还剩 M 条、本页还有 X 条；钉号=疑点序；选了「有错」才出现「写原因」；页头没有结论输入框，签字/退回都走确认框，补充说明为空时结论自动写「无改稿项」或「退回：N 条有错，见清单」。二维码只按完整扫码关注引导语核对，解码内容只能作审计证据，不能覆盖引导语结论或 bbox。确认单底部工艺说明 / 颜色要求 / 版本号 / 更新内容不进机审（只认字段名开头，不要误杀「备案版本号」「执行标准版本号」；旧单假疑点签字时也跳过）。离开核对页或打样台后，历史记录仍列出进行中的单并显示 `liveJobLine`，点进去仍是 WaitCard / 打样单。稿上 OCR 走 `hitText.ts`（`coverage.hit` 回退；命中比只在「查看全部」；窗和复制清单用同一套口语模板，禁止 `score=` / `0/5`；品名/品牌/logo 没字就说明稿上多半是图）。

## 审稿界面补充

离开核对页后看板/侧栏/历史记录仍看阶段，不要只把进度画在 WaitCard 上。核对页优先 SVG、失败自动退高清 PNG；初始无恒等 transform，只有非初始缩放/平移才用 CSS transform，`will-change` 只在平移时临时开启，不要接 OpenSeadragon。右栏布局、窄屏和键盘约束见 [界面合同](interface.md)。当前字段和备注草稿按登录用户、任务 ID、原稿/对红版本隔离恢复；成功保存才清除对应草稿，失败提示持久留在栏内。有未保存备注时，签字/退回灰着，旁边写「备注未保存，请先保存」；页头「保存备注」用 DESIGN.md 里现有次要按钮样式（圆角描边、非实心紫），不要用主按钮。切到手机宽度（含桌面拉窄）不丢备注草稿；本机存不了时弹「备注未保存，切换后会丢失」，确认丢掉才清。仅改人工操作前的草稿保护，不放宽既有服务端签字/对红门。存储拒绝或无稳定用户 ID 时退为内存态。右栏宽固定 320px，不能拖动调宽。收起、跨断点后重新定位当前字段。关掉「对照」时，点一条在还没放大的整页上不自动放大，只有已经放大才平移让框居中。编号钉不随画布放大成大圆，只有画布平移时临时隐藏框。隐藏钉只藏当前圆圈；显示框单独开关。

## 对照

电脑端核对页工具栏有「对照」按钮，文案在 `labels.ts` 的 `spot` / `spotTitle`。按钮用 `aria-pressed` 表示开关状态。本机 `localStorage` 键 `wb_review_spot`：缺省或 `on` 为开，只有 `off` 为关（`readSpotOn` / `writeSpotOn`）。视口 <720 不渲染这个开关，也不使用已存的开，也不把键写成 `off`。右栏仍是清单、待确认计数、签字和退回。

开着且「显示框」开着、当前条有可画的框时，只画这一条：

- 段落框来自命中里 `role=range` 的框（`drawableRange`）。宽和高同时超过页的 90% 才不画，不套错点框的 30% 面积。画得出来时它是对照卡所贴的框（`data-spot-frame`），底是透明的，类名带 `hit-range`，描边画在字外。错点框（`role=hit`）另画成框外细下划线（`hit-underline`），不占字的底边。没有段落范围时，这一只错点框自己当所贴的框，也用下划线。标记只钉在错点框上。
- 关掉对照时，`overlaysForHit` 跳过 `role=range`，只画当前字段的错点框。
- `groupsForSpot` 只留当前下标。同一页其他条不画，也不留淡框。
- 点清单、编号或当前框是同一动作。没有段落范围时，错点框自己就是当前框，也可以点。对照开着时，这一动作不展开 720–1439 的右栏浮层。当前框是 `span`（`role=button`），避免核对页按钮的 44px 最小尺寸把框撑大。
- 取景调用 `frameRangeForCard`。预留只有对照卡宽 440px 加间隙 12px，不再加右栏 320px。倍数不超过 6；算出来不大于 1 就回到整页。传给适配函数的视口仍是画布真实宽高。
- 对照卡（`review-spot`，默认宽 440px，间隙 12px，边距 8px）放在 `.canvas` 里、`.canvas-zoom` 外，用屏幕坐标，不写进缩放 transform。未拖动时贴在大框左右空档较大的一侧，宽度缩进那条空档，不压住大框。左右空档都小于 80px、且上下有更宽的缝时，改贴到那条缝里，多窄都缩进去。大框铺满画面时宽度收到 0，不往字上摊。拖动后只夹进同一套边距，不重新选边；换下一条也留在放下的位置。点「回到框旁」或关掉对照才贴回。右下角可以拖动改大小。用户拖出的宽度会留下；画面变窄时只临时缩小显示，放大回去仍用这个宽度。最小宽高不会硬撑过剩余空档。抬头移动满 4px 才算拖，小于 4px 算点击。抬头是拖动手柄，点到按钮不算拖。滚轮停在卡上，不缩放稿件。位置用样式直接写，平移时不每帧 `setState`。
- 卡内左列：有 `manuscript` 键时题「稿上读到」，正文是整段。没有这把键时题「稿上片段」，正文用 `pdf`，并写「不是整段」。
- 卡内右列只取一档，翻边不交换两列。状态是「稿件有但确认单没有」时只写「确认单没有这段」。`excel_row_count` 大于 1 时只写「对上了多行，不拼成一句」。恰好一行且 `excel_standard` 不是空串时才题「Excel标准」。其余题「差异片段」，正文用 `excel` → `excel_value` → `expected`，并写「不是整句标准」；旧单没有 `manuscript` 键时再写「旧结果，无整句」。整句里对得上的不同字符标出。对不上或同一片段出现两次就不标，并写原因。空格沿用空格盒。状态是「漏字」或「多字」时，两列上面直接标出少了或多了哪几个字，以及落在哪一侧；前后文片段在稿里出现两次时不猜缺口。
- 两列下面有「查看文字来源」展开项，默认收起，内容和右栏详情的「文字来源证据」一致：原稿文字和 OCR 原文。审稿员开着对照也能看到原文，不用关掉对照去右栏找。
- 上一项、下一项走当前右栏标签的池子，到头停止，不绕回。锁页时池子是全部。底下一排仍是一致 / 有错 / 忽略。原因只在选了有错之后出现，失焦才提交。待确认已空且本条已有结论时，写「待确认已空，签字仍在右侧」。卡的标题把字段名放在最前面，例如「中文品名 · 疑点 · 待确认 1/3」。字段名太长就截断，鼠标悬停显示全名。此时右栏不再展开同一条详情。

没有可画的框，或关了「显示框」，详情留在右栏。文案是「没找到位置，请看整页」；漏字框宽高都超过页的 90% 时是「没框住这一行」。已有任务没有段落框，新卡只能退回今天的小框；段落大框只出现在新跑的逐字核对上。已签字的单仍画当前条，结论按钮按原来的不可改规则禁用。逐字核对的「待人工确认」不进待确认条数；没有 `verbatim_warning` 时仍不挡签字。整单勾选只在 `verbatim_check` 单、且有 `verbatim_warning`、且仍有未决「待人工确认」时出现：页头勾「整单待人工确认，签字即认可」；勾上后签字按钮才可用；签字请求带 `order_held_confirm: true`。该勾选只约束签字，不约束退回：退回不需要勾选，退回请求也不传 `order_held_confirm`。没有未决「待人工确认」（含已全部下结论）不显示该勾选，也不挡签字。服务端 `/complete` 对签字在同样条件下未收到该字段时回 400，文案同勾选句；退回豁免该字段。手机宽度小于 720 时，未保存的原因退回已保存的 `hit.note`。

对照卡是 `aside`，`data-testid="review-spot"`，`aria-label` 是 `spotTitle`（「对照卡」）。端到端测试在 `apps/web/ui/e2e/review-workspace.spec.ts` 的对照用例里，它自己把 `wb_review_spot` 写成 `on`；同文件其他用例启动前写成 `off`，测的是关闭时的右栏详情。

操作见 [怎么使用对照](../howto-review-spot.md)。取舍见 [为什么对照卡贴在框旁边](../explanation-review-spot.md)。

## 审稿业务规则

以下规则以本节注明的代码为准。

- 完成时间按北京时间显示。`reviewFlat.ts` 的 `completedAtLabel` 固定用 `Asia/Shanghai` 格式化 `completed_at`：当天写「18:20」，同年写「10月9日 18:20」，跨年带年份。`completed_at` 缺失或无法解析时不写时间，不拿当前时间代替。
- 离线时不排队、不自动重发。下结论的请求没到服务器（浏览器报离线、`TypeError` 或 `status` 为 0）时，`decisionFailureText` 只提示「没连上网，这条没存上」。前端不把这条结论放进待发队列，恢复联网后也不自动重发，审稿员需要重新点一次。
- 飞书标题按完成类型写「已签字」或「已退回」。`notify.ts` 的 `taskCompleteHeadline` 读 `complete_kind`：`signed` 写「已签字」，`rework` 写「已退回」。旧任务没有 `complete_kind` 时，有「有错」结论就写「已退回」，否则写「已签字」。`/complete` 按有没有「有错」写 `complete_kind`。
- 进入已提交状态后不回滚。签字或退回后任务状态是 `completed`，界面写「已提交」。`/decision` 和 `/complete` 只接受 `pending_review` 和 `in_review`，对 `completed` 回 400，所以不能改结论，也不能再签一次。别人已完成的单在核对页锁定，并写明是谁签字或退回。对红新稿失败时，任务回到对红前的状态，已提交的单仍是已提交。
- 计费失败不影响审稿。对照结束后 `jobs.ts` 调 `compareBookkeeping` 记一笔识别用量。台账写入失败时 `recordCompareAttempt` 只返回 `recorded: false`，不抛错。对照结果、任务状态和飞书通知照常。

## 逐字核对、结论与落盘

逐字核对只接受 1 页稿。后端在打开 PDF 时看 `page_count`：超过 1 页直接 `page_over` 失败，不按页逐页试核。任务列表和任务详情用 `job_error_code` 标出作业失败码（共享码表 `apps/web/server/src/reviewCodes.ts` 的 `JOB_ERROR_CODES`；映射见 `jobs.ts` 的 `PUBLIC_JOB_ERROR_CODES`）：`page_over`（超页；CLI 私有码 `page_over_rendered`）、`ocr_failed`（认字没出结果：模型缺失 / 模型校验失败 / 版权声明缺失 / 依赖缺失 / 内存超限 / 百度 OCR 未配置）、`result_truncated`（结果超过输出上限）、`private_data_failed`（Illustrator 私有数据解压超限或解析失败）。只有这四个对外码；其他私有码不映射、不带 `job_error_code`。超页存盘的 `job_error` 只存前半句「稿件超过 1 页」（页数读常量，现为 1）；后半句「请改成 N 页后重新上传这一单」由前端按有没有「重新上传这一单」按钮拼（`labels.ts` 的 `pageOver` / `pageOverReupload`），没有按钮时只显示前半句。发版前留下的旧超页失败单存盘里没有码，也没有私有码，服务端在读取时补算：失败单的 `job_error` 整句等于「稿件超过 1 页，暂不支持核对，请联系管理员」或「这一单页数超过可核对页数」，任务详情和任务列表就返回 `page_over`；只认整句相等，不改存盘；新原文「稿件超过 1 页」不加进补算集合（新单一定带码）。任务重跑、跑成功或重新核对时清掉旧码。前端只按 `job_error_code` 判断，不再匹配文案。`job_error_detail`（`{ page_count?: number; max_pages?: number }`）先定格式不填，这一批接口里不出现这个字段，前端不依赖它。超页级别是「提醒」（`reviewErrorType` 对 `page_over` 返回 warning）；内部状态句「这一单页数超过可核对页数」不直接给审稿员。

下表是旧超页单补码的样例。`contractSamples.test.ts` 逐行拿这些存盘值去跑代码里的补码规则，改规则时要同时改这张表。

<!-- contract-samples:legacy-page-over -->
| `job_status` | 存盘 `job_error` | 读出 `job_error_code` |
| --- | --- | --- |
| `failed` | 稿件超过 1 页，暂不支持核对，请联系管理员 | `page_over` |
| `failed` | 这一单页数超过可核对页数 | `page_over` |
| `failed` | 对照中断 | 无 |
| `failed` | 稿件超过 1 页 | 无 |
| `running` | 稿件超过 1 页，暂不支持核对，请联系管理员 | 无 |
<!-- /contract-samples -->

没有私密 Illustrator 编辑数据时整单走警告路径：落 `verbatim_warning`（文案见 `verbatim_statuses.json` 的 `warning`），并把块做成「待人工确认」命中。列表最多 40 块；截断时最后一条 `note` 写「另有 N 块未列出」。右栏对这类未决项抬头用「认字存疑」。对照开着时对照卡题在 `labels.ts` 的 `spotTitle`（「对照卡」）。

「待人工确认」不能选一致：服务端 `/decision` 回 400（码 `decision_held_confirm_forbidden`）「待人工确认不能选一致」。前端结论按钮、快捷键 1/2/3 和 `decide()` 共用 `allowedDecisions`（`reviewDecisions.ts`）：该项只给有错 / 忽略。

认字预检在认领回执之后跑（新建对照与对红写新稿前都是）：`probeVerbatimReady` 缺依赖时对审稿员只回「认字出了问题，请联系管理员」，细节打服务端日志。同一 `modelDir` 15 秒内复用上次结果；并发请求合并成一次，不重复起进程。对红路径预检失败不覆盖 `artwork_v2.pdf`、不入队。

`fields.py` 的 `expand_query_variants` 与 `text_verify.py` 的 `is_ocr_column_glue` 直接导入，不再 try/except 换成空实现静默兜底。

审稿任务 JSON 落盘走 `tasks.ts` 的 `replaceFile`：POSIX rename 原子替换；Windows 上 rename 遇 EEXIST / EPERM / EACCES 只重试（最多 8 次、间隔递增），最终失败抛错，绝不 `copyFile` 覆盖。

任务详情返回的每条 `hits` / `hits_v2` 带读时投影字段 `hit_text`（`apps/web/server/src/hitText.ts`，加码 §5；不落盘；先做 `legacyCopy` 旧句替换再投影）：`{ v: 1, miss: string[], accounting: string[], evidence: string | null, observed: string | null, located: boolean }`。`miss` 是 `coverage.miss` 去掉空白和核算说明后的人话漏读词；`accounting` 是核算说明（`score=`、覆盖偏低等）；`evidence` 是人话说明（空或核算说明时为 null）；`observed` 取 `pdf` / `found`，否则 `coverage.hit` 用空格拼接；`located` 为有 `bboxes` 或 `qrcode_boxes`。前端 `pages/hitText.ts` 优先读这把键，旧接口没有时用同一份共享投影现算；展示前经 `customerCopy.ts` 的 `stripLocalPaths` 去掉稿面可见的本地路径（含路径里带空格），与服务端 `pathRedact` 互补。疑点是否「已标记要人看」前后端共用 `readingDoubt.ts` 的 `isFlaggedReviewHit`（按 `decision` / `status`，不按说明文字正则）。已标记但无 evidence 时核对要点只出 lead「这条请核对」，`because` 留空（只读/view-only 展示，不重复「这一面没读全」）。

面向审稿员的认字类报错：预检失败仍统一为「认字出了问题，请联系管理员」（`labels.ts` 的 `ocrFailed`）；作业失败经 `reviewErrorCopy` 按 `job_error_code === "ocr_failed"` 选句（有按钮 / 没按钮两句，见下面失败单那段），不露组件名、路径或堆栈。

失败单在核对页上的显示（`ReviewPage.tsx`，判断在 `reviewActions.ts`）。失败单指 `status` 为 `compare_failed` 或 `job_status` 为 `failed` 的任务。失败单一律不显示签字和退回按钮，服务端也不收（见下面签字和退回的门）。

「重新上传这一单」是真按钮，走和页头「上传新稿」同一个选文件 → `POST /api/tasks/:tid/rework` 流程（`canReuploadFailed`）。只有同时满足下面几条才显示：
- 服务端 `isReworkableTask` 放行，前端 `reviewActions.ts` 的 `isReworkableTask` 与它同条件：`pages_v2` 非空一律不放行；待审、审核中放行；`compare_failed` 只在 `job_kind` 为 `compare`、`job_status` 为 `failed`、而且还有有效条目时放行（产品哥 10/17 方案 A，回收中断和对照命令行自己失败的不区分）；已退回（`completed` 且 `complete_kind` 为 `rework`）放行。有效条目按服务端 `activeHits` 算，跳过工艺说明这类工艺表字段。
- 当前账号有 `create` 权限（viewer 没有），并且（是管理员，或这单的 `owner` 等于自己的 `open_id` 或显示名）。管理员看任何单都显示，包括没有 `owner` 的老单；非管理员看没有 `owner` 的老单不显示。前端用 `canAccessTaskOwner`，与服务端 `canAccessOwner` 同条件。服务端 `/rework` 用 `need(c, "create")` 和 `assertCanAccessTask` 独立拦，审核员替别人的单重传回 403，不落盘、不入队。
- 首次对照失败、没有条目的单不显示（见下一条）。

`/rework` 对 `compare_failed` 的单另做两件事（`index.ts`）：`status_before_job` 记成 `pending_review`，旧的 `error`（如「对照中断」）在开始重新上传时清掉。复核成功后进 `in_review`，能正常签字和退回；复核失败落回 `pending_review` 加复核失败，单子仍可读、在列表里能看到，新写入的错误保留，签字和退回仍拦，还能再重新上传。复核拿原 Excel 对新传的稿完整认字，上一轮条目只用来把选过「有错」的条目对上。复核成功写入 `pages_v2` 后不能再重新上传，和其他走完第二轮的单一样。

按有没有条目（hits）分两种：

- 失败而且没有条目（`failedWithoutHits`）：顶部只显示失败原因提示条。超页是黄色提醒，其他失败是红色报错。顶部的位置和翻页（‹ ›）、对照卡小标题里的位置、缩略图上的「✓ 看完」等标记、右栏底部的剩余条数和「复制修改清单」都不显示，免得让人以为这单已经核完。右栏「检查未完成，暂时没有结果」照常显示。
  - 对照失败（`compare_failed`）且没有有效条目，包括只剩工艺说明条目的（`isDeadCompareFailed`）：服务端 `/rework` 仍回 400（码 `rework_status_not_allowed`），没有接口能让这单接着走（Q4 已从加码拆出，另开 PR，本批不放开）。默认正文写「这一单没法接着核了，请回首页重新新建一单」（`compareFailedNoHits`），后面是「回首页」链接（`backHome`），只跳页面，不调接口；别人的单、viewer 等自己做不了的也不出纯文字「重新上传这一单」。超页无条目（`job_error_code === "page_over"`，产品哥 2026-10-17 定稿，`failedNoHitsBar`）：自己能动的单（有 create，且管理员或本人）标题「稿件超过 N 页」（读常量，现为 1），正文仍是上面那句 +「回首页」；别人的单只出标题「稿件超过 N 页」，无正文、无按钮。
  - 复核失败且没有剩余条目：符合上面条件时给「重新上传这一单」按钮。
- 失败但带着上一轮条目（`failedWithHits`）：上一轮的条目、翻页、「✓ 看完」、剩余条数和「复制修改清单」都保留。提示条按情况写。句尾叫人重新上传的那半句跟着按钮走：有「重新上传这一单」按钮才写，没有按钮（别人的单、viewer、服务端不放行）只写前半句（产品哥 2026-10-17）。判断和按钮用同一个 `canReuploadFailed`：
  - 复核失败（`job_kind` 为 `rework`）：红条「复核出了问题，下面是上一轮的结果，可以重新上传这一单」（`reworkFailed`），没有按钮时写「复核出了问题，下面是上一轮的结果」。
  - 检查中断，例如 `reclaimTask` 把卡在 `comparing` 的单改成 `compare_failed`、条目没清：红条「检查中断了，下面是上一轮的结果，可以重新上传这一单」（`compareFailedWithHits`），没有按钮时写「检查中断了，下面是上一轮的结果」。
  - 带超页码 `page_over`（复核失败和检查中断一样）：黄条「稿件超过 1 页，这次复核没做，下面是上一轮的结果。请改成 1 页后重新上传这一单」（`reworkPageOver`，页数取 `REVIEW_PAGE_LIMIT`），没有按钮时只写到「下面是上一轮的结果」。同一条里有按钮时不出「请联系管理员」。

失败条文案都由前端按 `job_error_code` 和单子情况选（`reviewErrorCopy.ts`），不显示服务端 `job_error` 原文。超页原文只存前半句，后半句按按钮拼，见上。认字失败按码 `ocr_failed`：有「重新上传这一单」按钮时写「认字出了问题，可以重新上传这一单，再不行请联系管理员」（`ocrFailedReupload`，产品哥 2026-10-17 定，留「再不行请联系管理员」退路）；没有按钮时写「认字出了问题，请联系管理员」（`ocrFailed`）。带上一轮条目的复核认字失败 / 检查中断照旧走上面的红条「复核出了问题…」/「检查中断了…」，不另给认字句。预检失败（`probeVerbatimReady`，见上）和首次认字失败仍写「认字出了问题，请联系管理员」，不改。`result_truncated` 一律写「这一单结果太多，没能写完，请联系管理员」；`private_data_failed` 一律写「稿件里的 Illustrator 私有数据读不出来，请联系管理员」（产品哥 2026-10-17 定，对齐设计稿 §2.3；不论有没有重新上传按钮，都不另造去掉「请联系管理员」的短句）。

签字和退回的门（`/complete`，服务端在 `completeGate.ts`，前端按钮在 `reviewActions.ts`）。两边共用一张规则表 `apps/web/server/src/signReturnRules.ts`，服务端、前端和 e2e 逐行对照，改了一边另一边的测试会挂。原则是该拦的两边都拦，服务端能独立拦住，不只靠前端藏按钮（产品哥 2026-10-17）：

- 对照还在排队或在跑：回 409（码 `complete_job_running`）「对照还在排队或正在跑，不能签字」。
- 任务状态不是待审或审核中（例如 `compare_failed`、`comparing`、已签的 `completed`）：回 400（码 `complete_status_not_reviewable`）「当前状态不可签字」。
- 复核（对红）失败（`job_kind` 为 `rework`、`job_status` 为 `failed`）的单，不管还有没有剩余条目：签字和退回都回 400（码 `complete_rework_failed`）「当前状态不可签字」（老板 2026-10-17 选 B，推翻 8/20 设计的「对红失败仍可签字」）。出路是上面的「重新上传这一单」。
- 有条目状态不在已知集合里，或结论值不合法：回 400（码 `complete_hits_invalid`）「有 N 条审核数据状态异常，请重新对照」；`params.count` 为条数；前端签字和退回都变灰，页头和悬停显示同一句原话，页头位置按全部条目计数，不写「全部已下结论」。
- 还有没下结论的条目：回 400（码 `complete_hits_pending`）「仍有 N 条…未处理」，按状态分开数，词序按首次出现，用「、」连接，例如「仍有 2 条待人工确认、1 条认字存疑未处理」；只有一类时写「仍有 1 条认字存疑未处理」。`params.items` 为 `{ kind, status?, count }[]`：`kind` 为 `status` / `reading_doubt` / `held`；`kind=status` 时 `status` 用英文枚举（`HIT_STATUS_CODES`：`suspect` / `field_missing` / `wrong_char` / `missing_char` / `extra_char` / `extra_space` / `missing_space` / `artwork_only`），中文只用于显示。待确认口径前后端共用 `apps/web/server/src/reviewIssue.ts`：`BLOCKING_STATUSES`（错字、漏字、多字、稿件有但确认单没有、疑点、缺失）与 `SPACE_STATUSES`（多空格、缺空格）；「缺空格」没下结论一律要结论（Q2），不再看核对要点有没有内容；「待人工确认」不进这张表（逐字单走整单确认，非逐字单由 `completeGate` 单独计）；认字存疑用 `readingDoubt.ts` 的 `hasReadingDoubt`，只看结构化字段，不看说明文字。已经下了一致、忽略或有错的条目不再拦。签字和退回共用这一句：前端签字旁提示、两个按钮的悬停、页头退回那行和退回确认框都显示这句原话，不加「处理完才能退回」；退回按钮照旧不禁用（老板 10/11 设计），被拦时确认框里「确认退回」变灰。核对页 `isReviewIssue` 与服务端同文件（`reviewEvidence.ts` import 共享实现），不再有状态文字正则。
- 逐字单有 `verbatim_warning` 且仍有未决「待人工确认」：签字要带 `order_held_confirm: true`，否则回 400（码 `complete_order_held_unconfirmed`）「整单待人工确认，签字即认可」；退回不要求。
- 只读账号（viewer）：服务端回 403「没有权限」（通用 403，不带码）；前端不显示签字和退回按钮。
- 别人的单：非管理员签字或退回，服务端 `assertCanAccessTask` 回 403「没有权限」（不带码）；前端两个按钮都不显示（`canAccessTaskOwner`）。管理员看任何单都能签能退，按钮照常。
- 页头叫人去做事的句子（右上「仍有 …未处理」和页头退回那行）只在签字、退回至少有一个按钮时显示，按钮灰着也算（`reviewFlat.ts` 的 `signHint` / `rejectNote`）。两个按钮都不在（失败单、viewer、非管理员看别人的单）时都不显示，疑点列表里的待确认数照常显示（产品哥 2026-10-17：做不了的事不叫他做）。
- 审稿相关 `/complete`、`/decision`、`/rework` 被拒时返回体是 `{ detail, code, params? }`（`ReviewProblem` → `app.onError`），码表与中文原文在 `apps/web/server/src/reviewCodes.ts`；`detail` 与加码前逐字相同，前端按 `code` 分支，拼文案要的数据放 `params`，不做文本匹配。通用 401「未登录」、403「没有权限」、404「任务不存在」、400「无效任务 id」仍不带码（Q1）。`/rework` 整包超限的 413 仍可不带码（实现用 `HTTPException(413)`）；单文件过大走 400 码 `rework_pdf_too_large`。

## 原生文字候选与公共证据

原生提取沿既有 CLI 的内部 `--native-dir` 参数传入当前已关闭 attempt；不接受 HTTP 任意路径。源稿和提取器版本不匹配时不复用，旧人工结论不回写。JSON 读取前 8MiB、深度 64、候选最多 10k；进入 PyMuPDF 文字设备前先限制每页原始内容流 16MiB、图像资源 256 个、候选 2k，提取结果再限制每页 10k 个文字行/trace 和 1M 字符，超出即回退。标准 PDF 文字层沿原有活字页规则使用；跳过 OCR 的新门只接受已经过稿面和渲染证明的 Illustrator 候选，且当前渲染的每一页都是 `live_text` 并有候选证明。确认单短语未被这些候选覆盖，或页面不是纯活字页、含大面积图片/扫描内容时，才回退到 OCR；一旦发生过原生尝试却未通过门禁，即使 PDF 分类为 `live_text` 也必须强制 OCR，不能复用陈旧 PDF 文字层。任何证据不确定都保持原有 OCR 回退，不把原生结果直接当作业务结论。

`native-text/1` 当前保守接受范围：原稿/导出 PDF 页数与物理尺寸一致，受限分辨率的可见稿面渲染逐字节相同；文字对象可见、无遮挡/剪裁、字体可用，且导出 PDF 在同位置含相同文字；OCR 与原生框唯一对应。bbox 相交不能单独构成证明。坐标/页面旋转、字体替换、遮挡或渲染差异不确定时不采用。纠正后的读法进入既有业务规则，不直接写“一致”或人工 confirm。

详情新增安全投影 `native_text`：status 为 queued/running/ready/fallback，reason/message 仅有原因时出现。ready 仅表示候选提取已完成且宿主关闭，不代表字段已通过验证。公开稳定原因 native_busy/native_offline/source_changed/close_unconfirmed/native_failed/save_timeout；`save_timeout` 表示 Illustrator 处于保存阶段且任务目录（含部分 PDF、debug.log、进度 sidecar）连续 300 秒无大小/mtime 变化，Agent 仅结束 pid+启动时间与本任务一致的 Illustrator、删除本次 attempt 的部分输出、核对原稿 hash 未变、在 Session 1 干净重启并 smoke，证实新宿主 0 文档后才写 close 并回退 OCR，同时发飞书告警；无法证实身份或关闭时不结束进程并保持 close_unconfirmed/故障栅栏。若看门狗结束后原稿 hash 与任务开始时不一致，原因为 `save_source_changed`：status 保持 running，不写 close、**不回退 OCR**、Illustrator 槽保持栅栏，飞书告警明确写“原稿可能被改动”，须人工核实后由管理员恢复（`recover-native-text`）。看门狗结束/重启（含无窗口僵死）每滚动 1 小时最多 2 次，记录持久化在 Agent `runtime\watchdog-restarts.json`；超限不再结束进程，Agent 进入故障栅栏并经 worker 公开原因 `watchdog_restart_cap` 发飞书告警（详情仍为 close_unconfirmed）。无窗口判定看该 pid 是否拥有任何可见顶层窗口（EnumWindows），不只看 MainWindowHandle，因此仍在加载或停在登录/授权对话框的 Illustrator 不算僵死；窗口枚举失败也不算。净版展开（unfolded_print）同样发看门狗告警；其 save_source_changed 沿用 close_unconfirmed 栅栏。不暴露私有 request、hash、PID、路径。

字段可选 `native_text_evidence`：version=1；status=used/conflict/not_used；native_text/ocr_text 为 string 或 null（各最多 8192 字符），message 为简短中文（最多 500 字符）。原生覆盖完整而跳过 OCR 时 `ocr_text` 可以为 null。仅传属于当前字段的证据，隐藏/不可信候选正文不投影。UI 只展示，不覆盖 hit.status、decision、原有定位、hits_v2 或签字/对红门；旧单缺该字段不显示来源卡片。

数值条码按完整数字 token 匹配：8–14 位条码必须在文本中以非数字边界出现，不能把更长的错误数字串当作命中；条码框仍沿实际词框投影。

融合采用前必须把完整原稿/OCR 读法、对应框及源/attempt 身份原子保存到私有 fusion-audit.json；保存失败或源稿变化保持原 OCR。单字段合并证据超过公共 8192 字符上限时不下发来源卡片，不静默截断冒充完整内容；完整融合审计仍私有保留。
