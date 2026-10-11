# 审稿与人工判断合同

本文件保存原 AGENTS 的对应工程合同，仅在涉及本主题时读取。产品行为不构成执行作业、发送消息或操作生产的授权。日期与验收状态是记录时快照，当前结论须绑定本次证据。路径除链接外均相对仓库根。

## 核对页与人工判断

核对页优先读服务端生成的 SVG 核对面，生成或浏览器加载失败自动退高清 PNG；SVG worker 必须独立进程、限时、限输出，失败写简短 problem/cause/fix。框在 `pinBox.ts`：有 bbox 才画真框，钉在框中心，不编造顶排钉。默认只画**当前字段**的钉和框；隐藏钉只藏当前圆圈，框仍在；显示框单独开关；拖动画布暂时藏框。永不恢复全页散钉。缩放在 `canvasZoom.ts`：初始 1× 输出 `transform: none`，非初始状态才用 CSS `transform` 1–6×；`will-change` 只在实际平移时短暂启用，拖动走 rAF 且禁止 img 原生拖拽，不上 OpenSeadragon。核对栏由 `ReviewWorkspace.tsx` 固定在画布右侧，默认 448px，可调 320–560px，保留画布 ≥480px 和 8px 分隔，工作区小于 808px 改上下布局。独立滚动、可收起、拖动与键盘调宽；宽度/展开状态按登录用户保存，不沿用旧浮窗位置；窄屏不覆盖桌面宽度。全屏下栏和下拉弹层留在全屏根节点内。疑点目录和待确认导航置顶；当前字段先用跟随外观字号的正文写嘱咐（lead / because / ask）再结论下拉，Excel 应印与稿上读到两列，「查看全部」才出命中比；包装定位写「没找到位置，请看整页」（系统文案不用「我」「你」，一行提示句末不带「。」，规则见 DESIGN.md「文案与状态」；because / ask 为空时不渲染，只剩一行时只出「这些字没读全，请核对」；旧单落盘的 JSON 不改：服务端在详情返回 `hits` / `hits_v2` 时（`publicTask` → `legacyCopy.ts`），按原句精确替换四句已知旧 evidence，即两句以「我」自称的净含量 / 毫升和条码提示，以及两句带句末「。」的净含量&条形码提示；其他文本原样返回）；这单还剩 M 条、本页还有 X 条；钉号=疑点序；一致/有错/忽略用下拉框，旁边复制，下一行人工备注；结论在页头签字旁。二维码只按完整扫码关注引导语核对，解码内容只能作审计证据，不能覆盖引导语结论或 bbox。确认单底部工艺说明 / 颜色要求 / 版本号 / 更新内容不进机审（只认字段名开头，不要误杀「备案版本号」「执行标准版本号」；旧单假疑点签字时也跳过）。离开核对页或打样台后，历史记录仍列出进行中的单并显示 `liveJobLine`，点进去仍是 WaitCard / 打样单。稿上 OCR 走 `hitText.ts`（`coverage.hit` 回退；命中比只在「查看全部」；窗和复制清单用同一套口语模板，禁止 `score=` / `0/5`；品名/品牌/logo 没字就说明稿上多半是图）。

## 审稿界面补充

离开核对页后看板/侧栏/历史记录仍看阶段，不要只把进度画在 WaitCard 上。核对页优先 SVG、失败自动退高清 PNG；初始无恒等 transform，只有非初始缩放/平移才用 CSS transform，`will-change` 只在平移时临时开启，不要接 OpenSeadragon。右栏布局、窄屏和键盘约束见 [界面合同](interface.md)。当前字段和备注草稿按登录用户、任务 ID、原稿/对红版本隔离恢复；成功保存才清除对应草稿，失败提示持久留在栏内，存在未保存备注时提示先保存再签字/上传改稿。仅改人工操作前的草稿保护，不放宽既有服务端签字/对红门。存储拒绝或无稳定用户 ID 时退为内存态。调宽、收起、跨断点后重新定位当前字段；编号钉不随画布放大成大圆，只有画布平移时临时隐藏框。隐藏钉只藏当前圆圈；显示框单独开关。

## 原生文字候选与公共证据

原生提取沿既有 CLI 的内部 `--native-dir` 参数传入当前已关闭 attempt；不接受 HTTP 任意路径。源稿和提取器版本不匹配时不复用，旧人工结论不回写。JSON 读取前 8MiB、深度 64、候选最多 10k；进入 PyMuPDF 文字设备前先限制每页原始内容流 16MiB、图像资源 256 个、候选 2k，提取结果再限制每页 10k 个文字行/trace 和 1M 字符，超出即回退。标准 PDF 文字层沿原有活字页规则使用；跳过 OCR 的新门只接受已经过稿面和渲染证明的 Illustrator 候选，且当前渲染的每一页都是 `live_text` 并有候选证明。确认单短语未被这些候选覆盖，或页面不是纯活字页、含大面积图片/扫描内容时，才回退到 OCR；一旦发生过原生尝试却未通过门禁，即使 PDF 分类为 `live_text` 也必须强制 OCR，不能复用陈旧 PDF 文字层。任何证据不确定都保持原有 OCR 回退，不把原生结果直接当作业务结论。

`native-text/1` 当前保守接受范围：原稿/导出 PDF 页数与物理尺寸一致，受限分辨率的可见稿面渲染逐字节相同；文字对象可见、无遮挡/剪裁、字体可用，且导出 PDF 在同位置含相同文字；OCR 与原生框唯一对应。bbox 相交不能单独构成证明。坐标/页面旋转、字体替换、遮挡或渲染差异不确定时不采用。纠正后的读法进入既有业务规则，不直接写“一致”或人工 confirm。

详情新增安全投影 `native_text`：status 为 queued/running/ready/fallback，reason/message 仅有原因时出现。ready 仅表示候选提取已完成且宿主关闭，不代表字段已通过验证。公开稳定原因 native_busy/native_offline/source_changed/close_unconfirmed/native_failed/save_timeout；`save_timeout` 表示 Illustrator 处于保存阶段且任务目录（含部分 PDF、debug.log、进度 sidecar）连续 300 秒无大小/mtime 变化，Agent 仅结束 pid+启动时间与本任务一致的 Illustrator、删除本次 attempt 的部分输出、核对原稿 hash 未变、在 Session 1 干净重启并 smoke，证实新宿主 0 文档后才写 close 并回退 OCR，同时发飞书告警；无法证实身份或关闭时不结束进程并保持 close_unconfirmed/故障栅栏。若看门狗结束后原稿 hash 与任务开始时不一致，原因为 `save_source_changed`：status 保持 running，不写 close、**不回退 OCR**、Illustrator 槽保持栅栏，飞书告警明确写“原稿可能被改动”，须人工核实后由管理员恢复（`recover-native-text`）。看门狗结束/重启（含无窗口僵死）每滚动 1 小时最多 2 次，记录持久化在 Agent `runtime\watchdog-restarts.json`；超限不再结束进程，Agent 进入故障栅栏并经 worker 公开原因 `watchdog_restart_cap` 发飞书告警（详情仍为 close_unconfirmed）。无窗口判定看该 pid 是否拥有任何可见顶层窗口（EnumWindows），不只看 MainWindowHandle，因此仍在加载或停在登录/授权对话框的 Illustrator 不算僵死；窗口枚举失败也不算。净版展开（unfolded_print）同样发看门狗告警；其 save_source_changed 沿用 close_unconfirmed 栅栏。不暴露私有 request、hash、PID、路径。

字段可选 `native_text_evidence`：version=1；status=used/conflict/not_used；native_text/ocr_text 为 string 或 null（各最多 8192 字符），message 为简短中文（最多 500 字符）。原生覆盖完整而跳过 OCR 时 `ocr_text` 可以为 null。仅传属于当前字段的证据，隐藏/不可信候选正文不投影。UI 只展示，不覆盖 hit.status、decision、原有定位、hits_v2 或签字/对红门；旧单缺该字段不显示来源卡片。

数值条码按完整数字 token 匹配：8–14 位条码必须在文本中以非数字边界出现，不能把更长的错误数字串当作命中；条码框仍沿实际词框投影。

融合采用前必须把完整原稿/OCR 读法、对应框及源/attempt 身份原子保存到私有 fusion-audit.json；保存失败或源稿变化保持原 OCR。单字段合并证据超过公共 8192 字符上限时不下发来源卡片，不静默截断冒充完整内容；完整融合审计仍私有保留。
