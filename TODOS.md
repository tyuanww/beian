# TODOS

这里维护未完成事项。每项保留稳定编号、当前已核实的进度、下一步、验收条件和证据入口。分段完成时更新对应阶段。结案后把发布和功能变化留在 [CHANGELOG.md](CHANGELOG.md)，把验收证据放回对应记录。真稿、产物和私有核验记录留在 Git 外。

之前的发布记录、评审和交接细节可按固定提交查阅。[精简前的待办记录](https://github.com/tyuanww/beian/blob/87b10e181e418772a55ed93421853f1fb48716ad/TODOS.md)

## 当前打样收尾

2026-11-25 已核实杭州生产为 **0.31.1.34**。合并提交 `87b10e181e418772a55ed93421853f1fb48716ad`。杭州发布、Illustrator 身份检查、Blender 质量门和公网版本均已核对。[PR #56](https://github.com/tyuanww/beian/pull/56) · [杭州发布](https://github.com/tyuanww/beian/actions/runs/45552881613)

10ml 混层原单已通过本轮验收。Windows 用同一原稿副本重新生成，核验了盒型、正面两处激凹和产物。该单的线上原尺寸 PNG 也已实际保存并解码。证据在仓库外的 `beian-evidence/mockup-hd-transfer-checks-20261125/`，分别见 `windows-original-acceptance.md` 和 `verification.md`。这两条记录分别证明本机处理和公网下载。

- [ ] **10ml 成片下载的线上复验。** 改动覆盖单份原尺寸 PNG、紧凑预览、关页找回和浏览器断点续传。待发布后用原打样单核验冷缓存首图、一次点击、关页和重新登录、弱网续传、背景和灯光一致性及文件完整性。记录从点击到保存的真实用时和传输字节。[成片合同](docs/contracts/packaging-presentation.md#导出与-ppt-规则)
- [ ] **最初报下载问题的 30ml 对照单。** 待用当前线上版本，在原页面点一次下载。验收时记录等待期间预览是否可用，并打开保存的原尺寸 PNG。[成片合同](docs/contracts/packaging-presentation.md#打样成片与背景)
- [ ] **最初报不能成盒的 10ml 备案图。** 获准后核对原稿指纹和层名，在 Windows 专用验收目录运行。记录刀线候选、盒身和上下封口。复验超邻接预算的 10ml「转曲 C」及已成盒的 30ml 对照稿，逐份记录通过或首个失败点。非路径对象和重合刀线已有专项回归。原样本记录在仓库外的 `beian-evidence/closeout-20261124-k1kdmp/illustrator-native-check.md`。[单稿导出](scripts/windows/README.md) · [结构合同](docs/contracts/packaging-structure.md)
- [ ] **复用 Windows 真稿验收。** 复用现有单稿导出和打样流水线，把版本、原稿指纹、阶段计时和实际产物核验收成一条获准后可重复运行的命令。验收时用已知失败输入确认能报告首个失败点，再用已知通过样本确认能生成回执。[测试与验证](TESTING.md#显式选择真实稿或原生应用)

## 状态与执行口径

- Code 记录实现。L0 记录本地或 GitHub 托管的测试。发版 L1 记录可信主线发布、杭州来源和公网版本。另记 Blender 质量门杭州实跑、真实稿 L2 和业务 UAT。真实稿 L2 需要对应样本及产物证据，UAT 由业务人员按实际工作流程确认。
- 工单只记录下一次验收所需的事实。开工前核对当前代码、证据和授权。执行细则见 [TESTING.md](TESTING.md) 和 [发布合同](docs/contracts/release.md)。P1 为质量或验收阻塞，P2 为可靠性或产品完善，P3 为独立后续和条件事项。

## P1 包装 3D 渲染质量

- [ ] **Q01 批准渲染质量基线与门槛。** Mac 合成现状基线已获准。按固定样本、profile、Blender 和环境采集，留机器结果、人工观察及审批。验收时明确适用平台、阈值和复测结果。[现有基线](workers/packaging/fixtures/render-quality/baselines/README.md) · [RF-08](docs/designs/packaging-quality-rf08-closeout.md)
- [ ] **Q02 矩形花盒真实感验收。** 现有视觉接受覆盖指定白盒及 80 mm 立方壳的合成静帧。补细长、矮宽、近立方、宽深不同及 A02 真稿。核对外尺寸、纸板边角、六面方向和静帧与 GLB 一致性，记录人工接受范围。[RF-05](docs/designs/packaging-quality-rf05-closeout.md)
- [ ] **Q03 纸材、油墨与涂层分层验收。** 四种材质的指定合成静帧已获接受。通过 Q06.9 核对 Windows 真稿的静帧和动态 GLB，再决定候选接线。结案需有材质接受范围、基线批准和回退证据。[RF-06](docs/designs/packaging-quality-rf06-closeout.md)
- [ ] **Q04 棚光、白盒边界与色彩管理验收。** Standard 已选作后续对照方向。受控对比 Standard、Khronos PBR Neutral 和 AgX 的正反图、边缘、暗阶与接触影，由真稿盲评和 Q01 门槛决定是否注册候选。[RF-07](docs/designs/packaging-quality-rf07-closeout.md)
- [ ] **Q05 端到端字体清晰度与浏览器性能。** 已有合成观察和采证工具。与 R04 共用实测，分别量首个小图、高清传输和解码、切代及离页。结案需有同条件记录、清晰度结果及 Q06.9 的业务验收。印刷面用 `read_*` 核字。[RF-08](docs/designs/packaging-quality-rf08-closeout.md) · [RF-09](docs/designs/packaging-quality-rf09-closeout.md) · [采证工具](scripts/resource-stress/README.md)
- [ ] **Q06 质量门、Windows 运行链与综合验收。** Q06.1–.3 的 RF-10、Q06.5 的 RF-11 和 Q06.6 A 隔离候选已有交付证据。Q06.4 的 Windows Job Object 异常路径暂缓。待有获准隔离机后核对取消、内存、崩溃、重启和进程树回收。
  - Q06.6 B 生产装配依赖 Q06.4 和既定审计。C 启用依赖 Q06.7/.8 和单独授权。现有候选默认关闭。
  - Q06.7 / RF-12 核对最终候选的旧单、代际切换、资源释放、回退和断电耐久。Q06.8 核对发布及受控准入。Q06.9 / RF-13 按 A01/A02 的真实稿和刘籽烨的操作流程验收，记录裁决、实际产物和未测范围。[ADR-007](docs/adr-007-packaging-render-fidelity.md) · [RF-03 收口](docs/designs/packaging-quality-rf03-runtime-closeout.md) · [RF-04](docs/designs/packaging-quality-rf04-closeout.md)

## P1 真实稿与业务验收

- [ ] **A01 膜袋 v1 杭州金标。** 补膜袋正样本和花盒、多片及一页多袋负样本。获准后逐份核对分流和 3 mm 薄盒预览，记录人工支持结论。[膜袋验收](docs/pouch-v1-acceptance.md)
- [ ] **A02 PackagingStructure V2 真实稿矩阵。** 13 份原稿指纹已核对。原批次其中一份在杭州完成结构导出，其余 12 份只核过本地导出参数。结案时逐份记录人工预期、成盒/拒绝、六面方向和实际产物，并为支持的结构族留下金标。[ADR-005](docs/adr-005-packaging-structure-v2.md)
- [ ] **A03 Illustrator 无人值守重稿 L2。** 待取得 26H21A 原稿许可、可执行窗口和预期。记录排队、保存、完工、关闭、是否需干预及产物。按宿主约束运行。[无人值守控制](docs/designs/illustrator-unattended-control.md)
- [ ] **A04 对红真实改稿金标。** 等待业务提供获准的旧新 PDF、改稿说明和二校真值。用实际结果核对漏报、误报、`hits_v2` 回退与签字门，并取得人工结论。外部处理先核对 B02。[审稿合同](docs/contracts/review.md)

## P2 作业与产品完善

- [ ] **R01 补印刷面持久队列与发版排干。** 代码已发布，合成覆盖同单幂等、跨单串行和恢复。补杭州业务与在途排干证据，确认重启后保留持久状态和已有成片。[R01 交付记录](docs/designs/print-face-queue-closeout.md)
- [ ] **R02 真金属地 / 木桌预设。** 先确认实际拒图原因和素材许可。需求成立后验预览及下载一致，背景切换沿现有合成路径，木桌为可选预设。[成片合同](docs/contracts/packaging-presentation.md)
- [ ] **R03 新单 PPT 与打样看板信息。** 待确认现有布景新单是否仍需 PPT、看板具体字段和用途。分别验实际打开的 PPT 和一行看板信息。
- [ ] **R04 切面与渲染资源压测。** 工具已发布，独占实测和预算未定。固定环境覆盖极端长宽比、最大像素、双上传、宿主 busy、重渲、排干和取消，记录峰值、恢复与预算结论。Windows 异常依 Q06.4。[资源采证](docs/howto-resource-stress.md)
- [ ] **R08 GLB WebP 压缩与旁路。** 校验和串行压缩已实现。剩余为缩小启动清理范围、单次超时和释放锁、可终止子进程及运维排障。复核当前的停用开关、试点和回填，及真后端双地址 `?v=`、缓存头、弱/多值 ETag 和旁路清理入口。超时后应保留原 GLB，下一单可继续。[成片合同](docs/contracts/packaging-presentation.md) · [历史交接](docs/handoff-2026-10-12.md)
- [ ] **R05 净版展开 PDF 与六面下载。** 代码已发布。用 A02 样本验六面 PNG/ZIP 和原尺寸净版 PDF，实际打印、裁切、折盒，核对粘口、封口、方向和完整稿面。几何或印刷来源不足时应说明限制。[成片合同](docs/contracts/packaging-presentation.md) · [最终执行方案](docs/designs/2026-10-09-r05-r07-final-execution-plan.md)
- [ ] **R06 图片 / PDF 批量压缩与自动目标大小。** 代码已发布。待验证 Windows 工具链、真实照片型备案 PDF 和带章报告。核对每个达标 PDF 小于 10,000,000 字节、已达标原件按原字节返回、文字与印章可读、签名受限文件的处理和失败回执。另补 99 MB 批量上限的浏览器回归。[最终执行方案](docs/designs/2026-10-09-r05-r07-final-execution-plan.md)
- [ ] **R07 压缩任务与统一历史记录。** 接线已发布，待业务验收。核对离页及刷新恢复、有权记录检索、返回位置、部分失败及重复下载，复用 R06 的样本和操作记录。[最终执行方案](docs/designs/2026-10-09-r05-r07-final-execution-plan.md)

## P2 审稿采用与合规

- [ ] **B01 审稿金标与采用。** 与刘籽烨核对漏报、误报及人工确认样本，记录能否连续同屏核对和第二周是否主动开单。B01.5 逐例验原生文字和 OCR 融合、对照真值及签字门。持续分屏或第二周未主动开单时评估 F05。
  - [ ] **B01.4 核对页业务验收。** 核对右栏和贴框对照能否支持同屏连续核对，记录实际操作结果。
  - B01.H1 不同规格稿件对比、B01.H2 营业执照与 Excel 核对、B01.H3 检测报告结论整理，分别待确认输入、核对字段和交付方式。[批次交付记录](docs/designs/2026-10-09-batch-local-closeout.md) · [原生文字交付记录](docs/designs/2026-10-09-native-text-local-closeout.md)
- [ ] **B02 真稿外部处理书面许可。** 原许可记录暂缓查找。实际调用百度 OCR、MiniMax 等之前，核对样本、权利人、批准范围和私有证据。权限未确定时用获准的本地方案或停在该步骤。
- [ ] **B03 仓库归属、第二管理员与主分支保护。** 2026-11-25 回读新仓 `main` 已受保护。已要求 `quality` 和 `windows-powershell-contract`，禁止强推和删除。严格同步、管理员受约束、线性历史和对话解决尚未开启。待确认公司归属、第二管理员、移交和需补的门禁。设置变更获准后只读复核。[迁移操作指南](docs/howto-repo-migration.md)
- [ ] **B04 多页稿逐页核对。** 当前单页上限由 `page_over` 明确拦截。上线逐页核对时将上限改为 4 页，逐页汇总结果。用合成与真实的两页稿各验一例，超过 4 页时给出明确提示。[审稿合同](docs/contracts/review.md)
- [ ] **B06 超页错误码。** 服务端返回 `page_over`，旧无码单有读时兼容。按当前主线核对前端是否全按码判断及首次失败、复核失败的展示。任何生产 tasks 统计或归档走独立授权。[审稿合同](docs/contracts/review.md)
- [ ] **B07 历史渲染操作者。** 2026-10-16 前的 `actor_label` 可能显示生成人。原业务决定保留旧数据。核验新封版显示触发人，旧账号形状的值对外隐藏，未知写 `null`。[作业合同](docs/contracts/jobs.md)

## P3 独立后续

- [ ] **F01 退役核对原型。** 主链已有清理。剩余待查三个辅助脚本的仓内及外部调用。取得静态、行为、运行入口和生产边界四类证据后再定删除范围。[ADR-006](docs/adr-006-continuous-complexity-governance.md)
- [ ] **F02 掉线与恢复告警。** 杭州托管已装，独立飞书 bot 的测试消息已确认。真实掉线与恢复证据待记录。等待获准的观察窗口，沿现有监控流程取证。[监控操作指南](docs/howto-local-monitoring.md)
- [ ] **F03 持久作业存储评估。** 暂缓。出现可复现的一致性问题或吞吐瓶颈时，先采最小复现，再比较修复现有 JSON 合同与迁移成本。[架构合同](docs/contracts/architecture.md)
- [ ] **F05 飞书机器人收文件回报告。** 由 B01 的采用结论触发。业务选定后，明确文件及报告范围、权限、费用和成功/失败验收。
- [ ] **F06 仓库迁移收尾。** 新仓发布链已可用。补 Actions 设置、原凭据停用或轮换方案及只读镜像恢复证据。保护见 B03。[迁移操作指南](docs/howto-repo-migration.md)
- [ ] **F07 Rollup 原生依赖。** CI 和 Windows staging 已有补齐路径。验证跨平台锁文件能否让 Linux 和 Windows 干净安装构建，再决定是否移除现有补齐步骤。
- [ ] **F08 WSL2 预发重新启用。** 预发已停用且禁用自启，原数据保留，议题暂缓。若获准重启，先修平台能力标识和登录控制，再单独核对 DNS 或隧道授权。[WSL 预发操作指南](docs/howto-wsl-staging.md)
- [ ] **F09 Node 20 测试覆盖。** 复现 Windows Node 20 和 UI glob 问题，核对同一 SHA 的 Node 20/22 server 结果及 UI 脚本。范围见 [TESTING.md](TESTING.md)。
- [ ] **F10 用户可见报错脱敏。** 任务、打样主要接口已有覆盖。剩余核对全局 HTTP 错误、告警、worker、补面和疑点证据，按原记录复验路径及凭据格式缺口。按角色跑可观察结果测试。[身份与设置合同](docs/contracts/identity-settings.md)
- [ ] **F11 飞书发送测试的接收人。** 已配置时送到该接收人且保留配置，空配置时给明确提示或禁用。真消息另获授权。[身份与设置合同](docs/contracts/identity-settings.md)
- [ ] **F12 签字通知的对红结果。** 通知摘要和任务摘要使用同一结果来源。验收只有 `hits_v2` 含改稿项时，「已退回」标题、数量和字段与详情一致。

## 核对页与交接跟进

- [ ] 核对 A 通铺后全站侧栏样式选项、`fetchPriority` 告警、遗留侧栏宽度状态、重复文案和颜色 token。用当前页面复现后逐项决定。保留 B01.4 的业务验收。
- [ ] 对照卡待验证旋转页框的位置，快捷键和拖动位置保留仍待产品确认。[审稿合同](docs/contracts/review.md)
- [ ] 无有效条目的检查中断单重新上传曾拆为独立 Q4。先用当前主线复核并核对明确决定，再在非生产环境验有条目、仅工艺说明、完全无条目及首次超页。保留角色权限、前后端一致性和轮次口径。
- [ ] 核对 401/403/404 通用错误码、`hitText.ts` 和已登记的文案匹配存量。继续由现有 lint 检查，按已验证缺口逐项收窄。[文案 lint](scripts/quality/error-text-match.mjs)
- [ ] 复核失败态 UI 的颜色、进行中文案及「复制」入口。3D 失败提示及 GLB 加载偶发问题复现后按状态和实际加载阶段验，采证见 Q05。
- [ ] `upload_limit_bytes` 下发仍暂缓。后续获准时同时核对 `/api/auth/me`、前端接受值范围、99 MB 默认值和 R06 的 E2E。
- [ ] 飞书「beian 前端优化方案」同步待业务安排。原始交接和历次评审证据见本页顶部的固定版本链接。
