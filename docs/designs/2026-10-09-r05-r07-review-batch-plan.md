> **历史方案与评审证据，已由[最终执行方案](2026-10-09-r05-r07-final-execution-plan.md)收口。** 实施以最终方案为入口，未完成状态见 [TODOS](../../TODOS.md)。下文保留不同阶段的原始默认值、建议和评审记录；其中 400px、六面之外的旧范围及后续被修订的规则不再作为最终实施口径。2026-10-09 按用户要求整理最终方案，未重跑完整评审。

<!-- /autoplan restore point: "/Users/hutou/.gstack/projects/weiweity-beian/codex-r05-r07-autoplan-restore-20261009-01.md" -->
## Implementation plan
# 备案附件与审稿改进批次：R05–R07 + B01.4/.5

日期 2026-10-09。计划基线 331bd107cd896e3ea47d5a29779cebacfc9251ae。工作树 codex/r05-r07-autoplan。当前只做落地讨论、静态检查、autoplan 独立评审；不实现产品、不试压、不运行真实 Illustrator/OCR、不提交/推送/发布。

## 用户决定与边界
这五项同一批次交付，内部可以分切片，不能擅自移除其中任何项。保留现有审核引擎、3D 流水线与飞书身份。R05 在已有 3D 单保留六面 PNG/ZIP，并新增源 .ai 的完整净版展开图，按原尺寸打印后可裁切折盒；净版展开打印是用户最新澄清，优先于历史评审中“整张展开 PDF 未承诺”的旧判断。R06 图片和 PDF 自动压缩，PDF 每文件严格小于 10,000,000 字节，彩色公章完整可辨。R07 与现有历史贯通。B01.4 明确把自由浮窗换成右侧固定侧栏。B01.5 用户确认 Illustrator 可复制正常中文并编辑内容；该样本标准 PDF 文字层为空、展示层为矢量路径，保留原生编辑数据。不能把“矢量”当成普通 PDF 可提字，不能宣称现已脚本验证。
旧 DESIGN 的自由拖动浮窗和四个导航项被上述明确需求取代；其他品牌、字号、SVG 优先、当前字段标注、签字权限等保留。原来的历史21主题不随本批关闭；B01.H1–H3 不扩入。

## 交付路径与界面
导航依序审稿台、打样台、文件压缩、历史记录、设置。文件压缩 screen 为拖入区、待上传列表、开始压缩主按钮；提交后是可恢复的批次详情。新 route /compress 与 /compress/:id，统一 history 支持 compression 类型。每行真实状态+大小+下载，失败原位说明。离页继续，刷新由服务端恢复，不用浏览器当唯一事实。
审稿 desktop sidebar 固定右侧，画布使用余宽；默认侧栏400px，可调320–560px且留画布最小可用宽。header 结论/签字保留；右栏疑点列表、短解释、Excel应印/稿上读到、人工结论、备注独立滚动。≤1024先折左导航；工作区不足时图与问题上下分区，不恢复遮挡画布的自由浮窗。控件≥40px；keyboard可调分隔条，折叠/展开焦点保留；1–6×、当前字段 bbox、无定位不画假框、SVG失败回PNG保持。缩放定位计算以画布实际矩形为准，resize保持当前字段可见；28px字体和390/1024/1440宽列人工检查。
R05 的“2D平面图”区有七个标签：2D展开图、正面、反面、左侧、右侧、顶部、底部。首项展示与本次3D绑定的源.ai完整净版展开稿，去刀线/折线/制作标注，保留原始物理尺寸、各面相对位置及粘口/封口；采用独立的“下载展开图PDF”作为1:1打印默认，不拼六面、不自动缩A4。六面PNG和“下载六面ZIP”保留。缺面、完整净版源件/几何不足分别说明；优先复用已有产物，需原生补导出时沿既有宿主队列，不为下载重跑3D。详见文末最新R05澄清及TODOS。

## 最小模块方案
选择沿用 Hono8787/React/Python worker 与磁盘持久任务，新增文件压缩作业种类；不部署整套Stirling站点，不加第三个HTTP入口，不引SQLite/通用任务框架。对比另起Stirling服务：后者功能多但身份/历史/端口/许可集成成本不合适。
图片选 Sharp；PDF 借鉴 Stirling-PDF MIT app/core 的目标大小算法，以小型本地 Java/PDFBox helper + qpdf CLI 执行，固定版本与许可声明、锁定MIT代码出处，排除商业engine和受限API。构建产物通过既有Windows发布依赖流程交付，运行时缺失有明确不可用原因。未做依赖安装或兼容性试验，不能把方向选择当可运行事实。
apps/web/server/src/uploads.ts 扩展压缩上传目的及动态文件清单，继续1MiB分片、两条流、owner+receipt幂等/claim恢复；不退回整包parseBody。初版建议每批≤20文件，总量≤100MiB、单文件≤100MiB（与既有限额同级），图片≤32MP；资源上限实际合成压力采证后再确认。start路由仅第一次save queued，之后 jobs.ts 唯一写任务；enqueue({kind,id})调度。compression 低并发独立执行槽默认1，必须进入queueSnapshot/drain/recovery，不占OCR/Blender计数但遵守总内存与磁盘预留。
数据新增 CompressionJob/CompressionFile：owner、createdAt、source_receipt、source identity/hash、attempt id、policy version、target bytes、逐文件 input/output bytes/产物key/状态/原因，批次由逐文件汇总。候选在任务私有attempt临时目录产出，校验后原子发布；迟到回调不能覆盖新尝试。重启只恢复确认未存活进程的工作；未知PID归属围栏。HTTP只暴露安全业务字段，不含本地路径/PID。来源和产物区分，默认跟现有历史长期保存+同权限手动删除，不擅自上线定时清理；磁盘不足拒绝新任务而非删旧文件。
权限：现有create权限方可提交/重试；history团队共享可见、删除权限沿既有同类记录规则；新download/status同范围校验。上传只能本人恢复。ZIP流式导出已成功项并清楚标注失败数，白名单key防路径穿越，不读任意客户端路径；重名安全改名，清单显示源名。

## 压缩策略与失败语义
PDF小于硬上限直接原字节输出，记录已符合要求；无需重写，更不为了压缩率破坏数字签名。超标先检查加密/签名，签名阻断自动重写并提示需另取未签名原件，用户未批准仅保留章外观；加密无法处理明确失败，不收密码首版。普通PDF结构优化后仍超标，从原件生成有限质量/分辨率候选，内部目标9,800,000，硬成功条件<10,000,000。有限8轮以内、单文件上限5分钟（暂定需采证）、从较高质量向下搜索，质量底线暂定150dpi/质量60，不牺牲文字/矢量，不自动整页栅格化/灰度/拆页；最佳达标候选不足安全质量则未达标，不虚报成功。图内公章/独立图章、透明蒙版、嵌套表单都须保留；结构校验页数顺序尺寸，保留可选文字，最后人工检查印章小字条码。压缩不是验证公章真实性。
图片默认质量优先自动压缩，保持格式透明度/方向/ICC与尺寸（除安全超限拒绝）；JPEG/WebP有损，PNG无损优先，无收益保留原件。图片目标大小未被用户指定，不强套PDF10MB；首版不新增目标输入控件，自动“尽量减小，保持清晰”。动图/多帧拒绝，避免只剩第一帧。
状态：queued/running/done/partial/failed；逐文件 succeeded/passthrough/unmet_target/unsupported/failed；timeout/磁盘不足/依赖缺失/内容校验失败稳定原因码，明确可重试项。未知质量无法承诺所有PDF均达标；原件始终保留。下载按钮仅发布后可用，缺失/过期展示原因。

## 原生文字支路
保留现有 render_pdf→pdf_ingest→text_verify/region_ocr→merge→字段匹配→人工终审。标准PDF可靠原生文字优先；无文字且有Illustrator私有数据的输入，以源稿hash绑定的提取请求通过现有Illustrator Agent/JSX宿主取得文字内容、坐标、画板/图层及可见性，不另建COM入口。返回JSON作为候选证据，映射PDF crop/rotation坐标，核对源稿与页面渲染一致性，隐藏层/画板外/备稿/被剪裁文本不能自动进入判定。缺字体、原生数据过期、映射失败、遮挡不确定或宿主不可用→该区域保留OCR并显示待人工确认；不能把整页有少量活字当全页免OCR，不能用AI文字覆盖图像区域漏检。
与打样共用Illustrator单槽与Agent busy/Session1身份、禁止Kill阶段；审稿等待不占OCR执行槽；本阶段仅提取、关闭不保存原件。请求有attempt、sourcehash、完成信号和围栏，超时按安全退出而非强杀Illustrator。缓存按sourcehash+提取器版本，重试不改人工结论；只有新审核运行采用新证据。对红hits_v2优先与签字门不回退。
B01.5 把识别差错、字段映射、规则和解释分开建立人工真值，减少OCR误报不是所有误报清零。原件提交审稿；压缩副本只用于提交附件，不能替换原生文本提取输入。

## 实施切片与验收计划（本轮不执行）
S1 R05 完整净版展开PDF/1:1打印折盒验收，以及六面清单/单张与ZIP/缺面旧单；S2 B01.4 布局+定位几何；S3 R06/R07 从上传持久任务到历史下载的垂直切片一起交付；S4 B01.5 原生提字调度、融合和金标；S5 全批回归、Windows兼容与业务UAT准备。五项同一批，R06不能无R07假交付。
每个切片补业务失败测试：6面真实身份/补面失败；侧栏resize/collapse/键盘/大字号/定位及签字回归；压缩大小边界、签名原字节、页数文字、混合批次、源件保留、重名ZIP、安全权限、并发限额、断电重启/迟到回调；native坐标/隐藏剪裁/过期数据/混合页/OCR回退与宿主busy禁杀。合成L0不触外网/COM。UI build后合成浏览器交互。真实PDF画质、印章、字体、Windows原生链与用户效果确认待另行明确执行；不以Mac/合成通过冒充L2或发布。
实施同步 DESIGN、interface、jobs、review、packaging contracts 和必要发布依赖文档；当前仅计划不改现状合同。完成须五切片可用、历史闭环、错误诚实、业务确认；不自动关闭Q01–Q06/A01–A04历史欠项。

<!-- autoplan-accepted:ceo -->
- 2D整套下载以中文面名和稳定面标识组织；矩形盒准确六面，缺面不称完整。测试六面/缺顶底/重复面/旧单源件丢失；ZIP必须清单与实际发布资产一致。
- 右侧栏保存宽度/折叠状态的新设置键，旧浮窗top/left不迁为右栏坐标；重置可恢复默认400px，窄屏不套非法宽度。测试旧localStorage、resize及当前字段/焦点不丢。
- 压缩失败项重试复用同批原件和新attempt；已成功结果不重压、不覆盖。不得复制history吞错误为空列表的行为，压缩历史加载失败显示可重试提示并保留上一有效列表。测试重复提交、部分失败重试、迟到回调。
- 运行时自动校验大小与结构后发布可下载候选；展示“大小已达标，请检查公章和小字”，不得称已验签/业务已验收。视觉检查不新增逐单签字阻断，但业务放行本功能前必须以人工核定的代表性照片PDF和带章报告验收公章、小字、骑缝章、条码、透明蒙版；未通过时不冻结150dpi/质量60为可靠政策。运行时发现内容结构/透明蒙版处理不支持则该文件失败并保留原件，不以数字质量参数替代内容完整性保证。
- 逐文件显示输入/输出大小、节省字节及百分比；passthrough为0节省；failed/unmet_target不展示伪造节省、不进达标ZIP。测试严格10,000,000边界、零节省和失败行。
- 图片默认自动压缩，不添加未指定的目标输入。R05最新范围为原六面PNG/ZIP＋完整净版展开图；展开图按1:1 PDF提供打印下载。此前单面PNG/ZIP偏好继续保留，但不能再作为排除整张展开稿的理由。新增源稿绑定、完整几何、辅助内容隔离、PDF物理尺寸及实物折盒的验收要求。
- 实施先完成R06/B01.5各自可行性门，再扩展完整接线：授权后用代表照片PDF和报告验证目标体积、公章/小字/透明保真；用人工真值字段验证Illustrator内容/定位/可见性与渲染一致。失败回到本批方案选择，不能凭回退成功宣称需求已交付。当前只记录实验矩阵不执行。B01.5记录旧/新字段误报、漏报、定位正确率及人工复核时间；已核定的真差异不得新增漏报，指定OCR误报样例必须整改，未达成保持待验收。
- R05单面仍用于查看/提交附件，保持原比例和像素；最新新增用途是净版展开稿按源尺寸手工打印折盒，保留粘口/封口且不打印辅助线。隐藏辅助线仅改变可见输出，不丢弃结构几何。商业印前色彩、刀模制造和自动多页拼接不随此自动扩入。
- 整批UAT按同一代表业务流程验证五项：同单取2D、照片PDF与带章报告的大小和可辨性、离页刷新历史取回、固定右栏完成疑点核对、目标原生文字样例误报改善且不增漏报；分别保留Code/L0/Windows/L2/UAT证据，未验不闭单。
- 新压缩路由采用/api/compressions/start、list/detail、retry、files/:key、zip以及终态delete，继续Hono身份校验：admin/reviewer可create，已登录可团队读取，修改/重试/删除按owner或admin且角色权限，viewer只读导出；owner写稳定身份ID，不以显示名授权。错误码和详情由一个公共投影产生；HTTP不返回私有路径、PID或原文文字日志。上传字段采用服务端分配的file_id，文件名只作展示；无文件/零字节/魔数不符/超量拒绝，路径/扩展名不能拼接进shell。
- 压缩所有子进程使用固定可执行文件+argv、不使用shell，文件名含引号/Unicode/../../不影响路径；工作目录内白名单文件，限制解码像素、PDF页数/对象数/单图解码预算、Java堆与输出/临时目录总量，递归Form XObject有visited集合与深度/对象预算。不能支持的蒙版/过滤器原样保留或失败，不解码后静默丢章。阈值在合成资源验证前仅为保守提案，资源不足拒单，不能删原件补空间。
- 压缩批次状态由全部逐文件状态确定：未全部终态保持running；全部达标/直出done，有成功有失败partial，全失败failed。重试失败项时已有成功产物仍能下载，ZIP标“下载已达标N项”并带成功/失败清单；0成功不提供空ZIP。重试/删除/下载/发布按同批串行变更围栏+产物读租约，删除先终态校验，活动下载保留其冻结文件集直至结束。测试发布先/删除先及下载先/删除先两种顺序，迟到结果不能复活墓碑。
- 观测新增compression槽与native提字阶段到现有队列/开工板和release readiness，记录任务/attempt/策略版本、输入输出字节、耗时与稳定原因码，不记录稿件内容。管理员可据错误码区分依赖缺失、资源不足、签名限制、未达大小、Agent busy/offline；业务页只给简短原因与下一步，不自动发消息。测试未知/损坏记录进入jobs_unknown，下载长流在drain内。
- 发布前在明确运维授权下预置新旧离线依赖包并校验版本/hash/许可，既有发布事务停服后不联网安装。新schema追加、旧任务惰性读取，原件不重写；关新增准入仍保留已完成产物读取。已接单后不得用不认识新job的旧版本直接回滚；先排干并保持fence，采用理解新任务记录的修复版本。回滚执行另行授权，当前只写合同和测试。
<!-- /autoplan-accepted:ceo -->

<!-- autoplan-accepted:design -->
- 混合批次主操作统一“下载可用结果N项”，摘要“可用N、处理中N、未成功N”；这细化CEO的“已达标N项”为PDF专属大小语义，不能把图片成功等同小于10MB。PDF行标“小于10 MB（10,000,000字节）”及“请检查公章和小字”；图片行标“已压缩”或“已保留原件，未进一步减小”，帮助文字明确图片未设置大小目标。ZIP只含图片成功/直出与PDF大小达标/原样符合项，失败项排除；零可用不显示下载。测试混合图片>10MB仍成功但不称达标、PDF精确阈值和重试期间旧结果可下载。
- 上传时序为选文件/本地初检→点击开始→逐行分片进度→服务端确认完整receipt→建立批次/排队。点击后冻结本次文件集合并防重复提交；上传中断保留收据与成功分片，重试失败上传，不静默提交不完整集合。未开始前可移除文件；冻结后如需换集合，明确结束本次未提交上传后重新选择，不影响已建批次。离页继续仅承诺服务端已接管的批次；上传中离页提示未上传部分会中断，返回尝试恢复，浏览器缺源文件时要求重选并校验身份；过期receipt明确重新上传。测试失败分片/重复点击/离页前后/过期与重选错误文件。
- 右栏按实际内容工作区宽度W判定：扣分隔条8px后，画布至少480px且右栏至少320px才并排，即W≥808px；并排栏宽clamp(已存宽或400,320,min(560,W-488))。W<808时画布在上、问题在下，画布目标40vh并clamp到240–420px，问题区独立滚动；短视口采用页面纵向滚动，不造成不可达控件或重叠。窄屏画布旁保留当前疑点摘要及上一项/下一项；图内仍可平移缩放。窄屏不覆写桌面宽度；返回并排恢复并夹限。拖动与键盘resize后重新计算canvas rect并保持当前字段可见；折叠栏按钮留在可见区域，展开焦点回到原控件或当前疑点。默认数值为实施基线，390/1024/1440及28px大字人工可用性验收后调整，不声称已验证。
- 压缩详情顺序固定：批次摘要/主操作→简短结果与限制→文件列表。排队不给虚构ETA，逐文件区分上传和压缩；轮询首次加载显示骨架与状态文字，刷新失败保留上次数据并标“更新失败，当前为上次结果”及重试。空历史显示创建入口；无权限显示无权限；404/资产失效明确不可取回，不能伪装空成功。失败原因就地给下一步，可重试按钮仅针对可重试项；后台继续时不夺取焦点。测试空/首次加载/旧数据失效/局部失败/全部失败/重试running仍有可用结果。
- 原生提字等待放任务阶段，不与已有疑点结论混淆；回退完成后提示限定到受影响字段/区域“此区域使用OCR，请结合稿面核对”，可展开原因。全单受影响才用整单提示，不额外改变签字门槛；无定位仍能看字段和原文，不画假框。没有field可承载的页面区域用页级提示。测试等待→回退→完成、混合来源、无bbox、人工结论不丢。
- 可访问性具体落实：上传区有原生文件按钮和键盘路径；结果行/面下载有含文件或面名的accessible name；状态有文字/图标不只靠颜色，进度用低频aria-live polite批次摘要避免逐分片播报；分隔条role=separator、方向/当前宽度/键盘步进，焦点清晰。常规文字对比≥4.5:1，按钮/边界≥3:1；>=40px目标沿现有合同，大字无横向整页溢出。手工检查Tab顺序、折叠恢复、屏幕阅读状态、窄屏上下两区和下载失败反馈；本轮不做运行验证。
<!-- /autoplan-accepted:design -->

<!-- autoplan-accepted:dx -->
- S3/S4交付时提供可复制开发指南：依赖矩阵（Mac/Windows、Node/Sharp原生包、Java/PDFBox helper/qpdf、版本/hash/许可、下载来源与离线预置位置）、helper可复现构建入口与能力预检。受控可执行文件发现顺序为已验证的显式本机配置→固定依赖包路径→开发环境PATH候选再校验版本；HTTP请求不提供工具路径。预检失败不领receipt。沿现有dev-start与TESTING入口，首个合成用例展示输入/结果字节、任务状态/原因码、原件保留；没有Illustrator仍能跑协议/融合合成测试，明确不能据此验收原生链。新命令在实施前不伪装已存在；指南例子需随实现实际复制执行核对。内部已准备环境首个理解性成功目标≤5min，计入读指南/解包/校验/helper构建/运行；冷启动安装全程另记，不新增遥测或定时任务。
- 压缩接口固定为POST /api/compressions/start {receipt_id}；首次201、相同owner/receipt重复200并返回同id；GET /api/compressions返回安全摘要列表；GET /api/compressions/:id返回详情；POST /api/compressions/:id/retry带expected_revision，仅重试服务器确认可重试的失败项，首次202，已受理的同revision重发返回同attempt，失配409；GET /api/compressions/:id/files/:key及GET /api/compressions/:id/zip导出已发布白名单产物；DELETE /api/compressions/:id仅终态且权限符合，返回200 JSON供既有fetchJson消费，活动作业409。精确上传session/complete接口沿现有uploads，receipt绑定服务端完整file_id集合，不接受客户端重写源路径、目标字节或owner。详情公共投影提供revision、terminal、counts、files、can_retry/retryable_file_ids、can_delete，客户端据此停止轮询和显示动作；权限最终仍由服务器复核。测试首建、重复start、同revision重试重发、部分成功继续下载、并发冲突、越权与JSON错误。
- 公共错误保留现有api.ts支持的顶层detail/code/reason，新增retryable/action/doc_ref为可选字段，不换成客户端不认识的嵌套error。以单一错误目录维护code→HTTP/任务失败原因→简短文案→可重试性→操作主体→修复步骤→仓库文档锚点；覆盖上传/运行/发布/恢复/下载/native回退，管理员才看受控诊断。业务页只展示问题与下一步，不暴露路径/PID/稿件内容；unknown_error保留task/attempt关联。qpdf退出3单列warning，不能只凭非零泛化失败或零退出认定合格；候选结构/大小校验仍必需，未知或影响内容的警告不发布。测试错误目录与前端投影对应、依赖缺失、超时、receipt过期、权限、签名阻断、fence及缺产物。
- 最小配置合同区分不可绕过的PDF<10,000,000字节、身份/原件/内容完整性，与受校验的资源预算/依赖路径/已验证策略档位。本机非密钥配置沿settings overlay，首版不给业务高级参数页；并发上限暂固定1，文件/批次/像素预算在既定上限内可收紧，放宽需先资源采证并更新版本化策略。质量/候选轮数/超时以有版本的政策清单管理，拒绝无效范围和未校准质量档位。每个attempt保存实际生效策略快照/版本及工具版本，配置变更仅作用新attempt，不能改在途子进程或已发布结果；诊断可显示安全数值/来源，私有路径只留受控本机日志。测试无效配置、运行时改设置、重试新策略、旧结果仍可读；当前150dpi/60只是假设，不标已校准。
<!-- /autoplan-accepted:dx -->

<!-- autoplan-accepted:eng -->
- E1：逐文件状态增加queued/running，终态为succeeded/passthrough/unmet_target/unsupported/failed。批次只要当前有文件running即running；无running而有queued为queued（可以保留以前的成功结果）；全部终态才聚合done/partial/failed。这个规则细化并取代CEO“未全部终态保持running”的概括。重试仅失败且可重试项转queued、产生新attempt/revision，既有成功产物不变；旧revision重发幂等，迟到结果按attempt/revision拒收。新增两任务竞争单槽、重试排队、混合终态、重启恢复测试。
- E2：下载使用冻结的已发布文件清单、流式背压与读租约；连接取消/异常/结束均在finally释放。初版暂定每身份2条导出、全局4条，120秒无进展或15分钟绝对期限终止该连接并给可重下载提示，数值纳入策略配置及后续合成验证。drain拒绝新导出，已开始导出按同一有限策略结束；发布等待达到既有期限则中止该次发布并保持旧服务，不为发版强删文件/终止Illustrator。删除先写墓碑阻止新读取，已有读租约归零才清理。测试慢客户端/断开/超时/删除竞态/排干不能误报空闲。
- E3：准入预算从上传session、未消费receipt到已接管queued/running源件连续计费，不得在claim时先释放再重新申请。沿既有每owner400MiB、全局1GiB暂存预算扩展计数范围，并限制已接管非终态批次每owner8/全局64；这些是初版保守限制，不改变单批20文件/100MiB。同一预算锁下检查并预留，源件从receipt转入job只转移不双计，崩溃恢复用持久记录重建保留量；临时/输出空间另有每任务上限和磁盘安全余量。每轮写候选前复核真实空闲空间，其他任务占盘时失败保留原件。终态退出积压配额但仍占真实磁盘，不自动清历史。并发最后额度、claim各崩溃点、服务重启、他任务占盘均需故障注入验证。
- E4：PDF先有界检查魔数、可打开性/结构及安全限制，再判断体积。需密码或加密权限不允许读取/处理的文件为unsupported，不收密码；已可合法读取但有修改限制且原件小于10,000,000字节可以逐字节原样直出，不解密/重写；超标且不能修改明确失败。损坏/不可读即使小也不称成功。数字签名原件小于限额只原字节通过，不代表验签；超标禁止自动重写。测试小文件损坏/需密码/只读原样/签名hash及恰等于10,000,000的边界。
- E5：新增compression持久化不得使用tasks.replaceFile的Windows copyFile覆盖分支。采用已存在mockupAtomicWrite的受控路径、独占同目录临时文件、写完fsync、rename原子替换模式；rename失败旧记录不变并清理本次临时文件，不先删旧文件、不copy覆盖。任务接受顺序为保留claim→源件可靠安置并hash→queued清单持久成功→commit claim→入队；重启按source_receipt识别已接单，避免重复/丢原件。产物先落不可变attempt目录，再发布manifest；失败不能暴露半份产物。墓碑与revision比较同串行写者。测试每个崩溃点/rename失败/旧attempt/删除后迟到；Windows原子可见性与断电耐久分开报告，不把Mac测试当耐久证明。
- E6：新增AI候选不改现有标准PDF层分类为live_text。混合页继续现有整页单OCR，再对通过hash/坐标/可见性验证的候选做区域证据融合；无法确证关联保留两路来源并标疑点，不能覆盖成“一致”，不加第二OCR引擎。沿现有compare_core的1–4页夹限与当前用户选择，记录实际处理页/画板覆盖，不把审稿暗改为全报告审查；PDF压缩保留全部页是独立合同。原生候选缓存绑定源件、提取器和坐标映射版本；旧人工结论不刷新覆盖。测试少量AI活字+图片文字、隐藏/遮挡/旋转/裁剪/超出处理页及真差异不得新增漏报。
- E7：扩展JobKind、enqueue返回类型、queueSnapshot、health/readiness/drain与reclaim所有分支，损坏/未知compression记录计unknown并阻止误判空闲。native预阶段通过现有共享Illustrator单槽及固定capability命令取得JSON；忙时排队不占OCR，确认能力不兼容/等待截止时带原因回退，未知宿主执行状态保留fence。默认native等待上限暂定120秒，从任务进入native等待计时，受策略快照约束；不用强杀解锁。共享槽FIFO兼顾打样，native完成释放后再领OCR，恢复不能同时重放AI与OCR。新增模拟busy/能力不符/晚到/重启/FIFO/排干测试；真实Session1验证另行授权。
- E8：任务list/detail从持久摘要及安全投影提供状态，轮询不读取PDF内容、不重算hash、不重生成ZIP。图片/候选按文件串行并有解码/堆/磁盘上限；导出流式且冻结文件集。复用现有测试harness和依赖注入，纯几何与状态函数测试不新建测试专用产品接口。新增功能的测试分组按下述图及独立测试计划；真实样稿、Windows宿主、画质和业务效果均独立验收，本轮只静态规划。
- E9（本轮native补充）：Sharp的元数据探针、解码、ICC处理与编码全部在独立图片worker子进程执行，Hono不加载Sharp解码业务；使用固定入口和受限JSON/文件协议，所有native分配/缓存/专属后代计入MR5压缩工作组预算。进程异常或超预算只结束已确认属于本attempt的压缩工作组，写稳定worker_resource_limit/worker_interrupted原因，不影响Hono、审稿或共享Illustrator；隔离/限制能力不足则预检拒绝。G11/17补worker崩溃、堆外超预算、主服务仍能health/读取历史与处理其他作业、无遗留子进程。
- E10（本轮native补充）：新压缩列表采用有界摘要索引与分页，GET /api/compressions支持limit默认50最大100及不透明cursor，响应{items,next_cursor,has_more,index_revision,partial}；按(created_at,id)倒序唯一排序，cursor绑定筛选条件与扫描上界，新建项在刷新首屏时纳入，删除项略过不造成跨页重复。可重建摘要索引随单写者持久提交更新，不每次HTTP扫描/解析全部job正文；索引无可信快照则明确503/index_rebuilding，不伪空成功，损坏记录计unknown并给partial诊断。UI沿现有历史筛选和分页区域接入：压缩筛选在服务端应用创建人/日期条件，变更筛选重置cursor；“全部”按相同全序惰性合并既有task/mockup/upload摘要与压缩分页，只补足所需可见窗口及一页预取，未加载完不得拿本地子集当总数/全部创建人/全部结果。通过服务端索引提供过滤后的计数和创建人摘要；游标页锚点支持返回已访问页，未有锚点的深页跳转不暗中抓全库，沿分页区域显示顺序翻页/继续载入及未知总量提示。详情轮询只读当前job，历史只增量刷新当前可见活动项，压缩页缓存至多3页并按索引版本失效；不顺手重写旧类型存储/引数据库。新增分页边界、同时间戳、过滤后旧记录、并发新增/删除、索引崩溃重建、混合来源完整排序/计数、损坏记录与10倍合成记录量每次响应≤100项且不全量读job的测试。此为原R07/E8的有界读取细化，实施同步api.ts类型与既有历史加载状态，不新增业务功能。
<!-- /autoplan-accepted:eng -->
## 外部反馈后的工程细化（2026-10-09）
以下补全既有实现条件，五项范围、PNG＋ZIP、右栏400px、唯一服务入口和先不验证保持。前文“暂定/最终gate”的偏好已由用户批准；本节细化优先于前文概括，不取消前序接受义务。资源数值是未实测的保守开发初值，不是已证明的安全容量。

- MR1 证据融合：AI候选必须带source hash、page/artboard、坐标变换、字体/可见性及来源对象标识；bbox重叠只是检索线索，不是相同文字的证明。原始OCR词、AI候选及可见图像证据均保留，字段记录所用来源与关联理由；不通过全局prefer_layer覆盖OCR，也不因候选覆盖框吞掉邻近/底层图片文字或其他独立字段。归一化后内容相同且归属唯一可合并展示；内容不同，只有可复现的稿面对应证据能够明确证明是同一可见文字且OCR误识别，才允许采用AI纠正识别。纠正不能直接把业务字段设为一致，仍经过既有字段比较规则。若对应关系、字体替换、遮挡/裁剪或可见内容无法证实，保留双方并标待人工确认；不要求AI与错误OCR必须字面一致，也不把原生来源身份当正确性证明。实施可行性门必须给出至少一例有证据的OCR纠正与一例重叠图片真差异不被吞掉；若无法实现可靠自动归属，只显示候选供人工核对，且不得据此宣称B01.5自动误报整改已验收。G16补AI框覆盖其他图片文字、字体缺失/替换、隐藏/画板外/部分剪裁、同形异字；断言真差异不漏、未解决冲突不一致、已证实识别纠正仍走规则判定。
- MR2 源件与宿主隔离：native提字只打开本attempt私有目录的实体副本（非symlink/hardlink），复制前冻结源身份，副本及提取前后源件hash须匹配。JSX只允许访问受控副本路径，输出独立JSON；不另存源稿、不修改原件权限、不共用打样正在打开的文档。对话框抑制沿现有宿主，缺字体/链接/恢复弹窗仍视为可能失败，不能靠DONTDISPLAYALERTS宣称无阻塞。区分native_busy、native_offline、native_source_changed、native_close_unconfirmed。120秒是未开始执行前的排队等待预算；已进入opening/inventory/writing_result/closing后沿宿主禁杀及执行期限，不能120秒到就释放槽或删除副本。结果JSON只代表候选完成，必须另有同request/attempt且版本匹配的关闭/桥接退出确认，确认本次文档已关闭、没有未完成请求、执行锁可安全归还，才清fence并允许后续槽使用。没有确认则保留active/faulted围栏，OCR可以作为逻辑回退，但旧native请求仍计在途，晚到结果不得覆盖回退；不并发重发native，不kill Illustrator。已有faulted仅经既有管理员恢复流程解除，不因单次idle心跳自行抹除。副本在无执行者/无文档引用被证实后清理；未知时保留并计磁盘。G15/17补关闭前已有JSON、缺字体弹窗模拟、晚到、重启、源hash不变、故障恢复正反例；真实Session1另行验证。
- MR3 PDF签名判定：用有界PDF解析访问结构，不用裸字符串grep签名。分开记录数字签名/修改限制与可见印章。已填充签名字典、签名上下文的ByteRange/Contents、Catalog Perms/DocMDP或签名引用中的变更策略出现时，保守标signed_or_modification_restricted；包含增量更新时检查当前对象引用及可访问的先前签名修订，不能仅查最新页可见元素。解析不完整/签名状态不明则不重写，返回signature_status_unknown/unsupported，不能当无签名。空白签名字段/seed配置本身不等于已签；单纯印章图片、Stamp注释或普通表单外观也不等于数字签名，可按普通内容进入压缩但必须保持外观、透明和页面关系。签名或受限原件在通过可读预检且小于10,000,000字节时只能逐字节直出；达到/超出上限则signed_over_limit/modification_restricted失败保留原件，不提供仅保留外观的重写。这里不验证签名有效性。G09补小签名整文件hash、超标签名、增量签名/DocMDP、空签名域、独立图章/Stamp、未知签名状态与现有密码/损坏样例。
- MR4 压缩停止条件：先检查无损结构优化结果；从原件按策略中明确排序的有限候选档位由高保真到低保真生成。候选通过内容/结构校验、达到允许的质量底线且实际字节<10,000,000，立即停止并发布该候选；不得仅为追9,800,000继续降质。9,800,000只作估算余量，不是第二道成功门或继续搜索理由。候选质量排序按预先定义的分辨率/编码组合，不假设不同PDF的体积严格单调；所有轮次累计仍受8轮/5分钟预算。保留不重编码的图像对象不影响整文件硬门。所有合格档位超标为unmet_target；内容不合格不可发布。G10补9,950,000高质量候选停止、后续候选不被调用、9,999,999/10,000,000边界、仅低于底线才达标不得成功，以及体积非单调但有限停止。
- MR5 有界解析策略v1：PDF最多200页、100,000个解析对象（含对象流展开后的对象）、Form嵌套32层且visited集合去循环；单内嵌图片≤32MP、单图预计解码≤128MiB（按实际分量/位深和蒙版累加，超任一限制拒绝），单文件一轮解码流总量≤1GiB。页数是整文件准入限制，超限明确resource_limit，不截页压缩；审稿既有1–4页选择独立。Java初值-Xmx256m，单压缩子进程及其专属子进程合计RSS≤768MiB，压缩工作组额外内存预算≤1GiB；Sharp/qpdf/helper分阶段顺序执行，OS限制/监控在解析启动前布置，不能只把Java堆当总内存上限。每压缩attempt的临时+输出合计≤2GiB，单候选≤128MiB；接单/开跑原子预留预计峰值，卷空闲减去其他已预留预算后必须仍覆盖本次预留＋2GiB安全余量；运行中监控实际占用，写入前检查，不靠事后全盘扫描。native候选JSON≤8MiB UTF-8、嵌套≤64、最多50,000个文本候选，读入JSON前限制字节并在JSX写出时计数/计长；不截断伪成功。图像完整解码前受限探针读尺寸/帧数，完整解码再次强制限制。恶意结构在页数/对象计数能读到以前就可能耗资源，因此预检也放受控子进程并纳入同一时间/内存/磁盘限制；实现若无法执行这些预算，该平台压缩能力预检失败，不接受无界降级。native限额在JSX内协作失败并安全关副本，绝不把压缩子进程资源终止规则套到共享Illustrator。各值均进attempt策略快照，放宽需新版本和资源证据，收紧不追溯在途。G06/09/10/15补页/对象/循环Form/深度/像素/解码流/堆外内存/临时盘/native JSON边界及预检阶段耗尽。
- MR5a qpdf结果按命令解释：普通转换/--check的0为无错误警告、2为错误、3为警告；--is-encrypted/--requires-password按各自官方语义解析，不能复用普通退出码表。不得使用--warning-exit-0或--no-warn隐藏警告。转换/校验的3进入有版本的警告分类，未知、恢复损坏或影响内容的警告均不发布；明确无内容影响的已审核白名单项仍需大小/结构/内容校验。v1白名单为空，故v1实际拒绝所有转换/校验警告，后续扩大白名单必须有夹具证据；这不是将退出码3永久等同处理失败。G10补普通0/2/3、未知警告、白名单为空，以及加密探测同码异义；固定argv，文件名Unicode/引号/../不进shell。
- MR6 重试矩阵由现有单一错误目录驱动，服务端状态、can_retry和按钮一致。magic_mismatch、pdf_corrupt、password_required、signed_over_limit、modification_restricted、deterministic_content_invalid：同一不可变原件不重试，需新原件新单；signature_status_unknown、unsupported_filter、resource_limit、qpdf_warning_unapproved、unmet_target：仅相关受验证策略/工具能力版本改变后才允许重试，纯版本字符串或无关配置变化不满足。dependency_missing/incompatible与disk_insufficient：管理员修复/空间恢复且能力预检通过后可重试；若发生在start前不领receipt、不创建假失败job。timeout/worker_interrupted：仅确认旧执行者结束、无fence且有剩余重试预算可重试；同源同策略最多3次人工重试（初次之外）、间隔至少30秒，限额后需相关修复或新已验证策略。native_close_unconfirmed不是压缩重试原因，不在业务按钮中清宿主围栏；busy保持排队或既定回退。重试只处理服务器确认可重试失败项，新attempt与策略快照；成功产物hash不变。无可重试项/前置条件未满足返回409带稳定reason；可受理首次202，同已受理revision重放返回同attempt。G08补每类原因、修复前后按钮/HTTP、相关版本变化、重复点击、限额及成功产物hash。
- MR7 图片方向：有收益且重编码的图片按EXIF Orientation将像素转到用户可见方向（含镜像），随后移除方向标签或写为1，不能把旧非1方向再带回输出；90/270度旋转允许存储宽高互换，可见尺寸/比例不变。若保留XMP等元数据须同步清除/归一其方向，否则不复制冲突方向字段；ICC与透明仍按既有约束保持。无收益直出的原件按原字节与原Orientation保留，不为归一化重写原件。G11补EXIF 1–8、非方形、镜像、冲突XMP、双次显示不双转、无收益hash不变。

## Review record

### Intake 与 CEO Step 0
Methodology read: autoplan-ceo-methodology-FPBFbk/methodology.md 1–600, 601–1200, 1201–1800, 1801–2400, 2401–2464 through EOF。Autoplan覆盖独立skill的问题/导航/报告路由；按AGENTS跳过附带升级、遥测、知识库同步和配置修改。计划备份与评审快照是本次产物，不是自动git checkpoint。
Scope工具 hash 3aefae0139e31baa8a324459b346826a047e50320b799485c30c3f82ddf9545c，API1/CLI1/agent2，matchCount4，DX required=true；UI screen/sidebar/header多处，required=true。历史office-hours文档标HISTORICAL/SUPERSEDED，只作背景。
Audit：原工作区与附着工作树TODO一致；两条旧stash只记录未动；30条历史以发布文档和render质量变更为主，本批不重做。CodeGraph在工作树报告未索引，退回定点源码；不重建。实际history是UI聚合tasks/mockups/uploads，未有history后端资源。jobs.queueSnapshot目前仅ocr/blender/illustrator，不能仅新增worker而漏掉排干计数。uploads目前100MiB、两条流；扩展类型需显式枚举。现有Illustrator Agent握手版本/脚本hash/交互session，作为提字唯一宿主。
Taste references：uploads.ts 的durable claim；jobs.ts补面持久请求/代际围栏；ReviewPage当前字段定位。避开HistoryPage吞mockup错误为[]的模式（新增compression不得复制静默漏列表）；避免继续把新功能全部塞入index.ts/jobs.ts长分支。
0A：真实痛点是备案附件可提交、同屏人工核对、少抄字和少误报；不做则用户继续另找压缩工具、双屏、把原生文字走OCR。五项直接对痛点；误报不能只归因OCR。
0B：R05复用MockupPage/read_*、mockup.ts、structure_v2/artwork.py；R06/R07复用uploads.ts/jobs.ts及HistoryPage/historyRows；B01.4复用ReviewPage/canvasZoom/pinBox/hitText；B01.5复用pdf_ingest/text_verify/region_ocr/compare_core与Illustrator现有宿主。不重写。
0C：CURRENT 分散下载+手工压缩+遮挡审稿 -> THIS 同单附件+后台压缩历史+右栏+候选文字证据 -> 12个月理想 为已确认稿生成可追溯备案附件并人工终审。缺口仍是业务金标、杭州原生证据和目标系统实际提交接受，不扩大本批自动申报。
0D：无需重问已定五项、开源借鉴、右侧栏。实现方向选择小型PDFBox/qpdf helper，替代完整Stirling服务；后者增加身份/部署边界，违反唯一产品入口。仅方向确认，不等于依赖可运行。
0E：SELECTIVE EXPANSION，由autoplan规定，不因>15文件自动砍用户范围。预计30–45文件含测试/文档，是估计；按5切片保持可审阅。
0F/0G：10x ambition = 从原稿到可提交附件与可追溯人工结论。平台潜力是持久产物与来源证据，当前不建平台。
Delight候选与处置：P1已达标直接返回（S/低，接受，既有需求）；P2压缩后大小与节省直观显示（S/低，接受）；P3整套2D有中文面名（S/低，接受）；P4侧栏记住宽度（S/低，接受，局部体验）；P5失败项重试保留成功结果（M/中，接受，历史闭环）；P6压缩后自动发飞书（M/高，拒绝，无发消息需求）。五个接受项是范围内小改，autoplan P1/P2/P4/P6授权；不新增外部通知。
HOLD检查：不新增第三服务/数据库/通用插件；文件数多来自跨层接线，按深模块收敛，必需异常不删。历史H1–H3已明确不入本批，不另建重复TODO。

| ID/owner | Contract/evidence | Current | Proposed | Status | Exact approval/scope |
|---|---|---|---|---|---|
| U1/user | 最新消息 | 五项同批 | 保持 | approved | R05–R07、B01.4/.5全部 |
| U2/user | 先不验证 | 只计划静态检查 | 保持 | approved | 禁本轮真实/合成产品试跑 |
| U3/user | 浮窗改右栏 | 右侧固定 | 保持 | approved | 保留其他审稿合同 |
| U4/user | AI可复制编辑 | 原生文字候选路径 | 保持 | approved | 不把矢量等同标准文字层 |
| M1/primary | autoplan P4/P5 | 持久作业/8787 | 扩展现有结构 | approved | 不另起服务/数据库 |
| T1/primary | 产品格式 | 单面PNG+ZIP | 对比整张展开 | provisional taste | 保留本轮PNG+ZIP建议，最终gate可改 |
| T2/primary | 工程默认值 | 20文件/100MiB/1并发等 | 合成采证再冻结 | provisional taste | 非用户已批准资源承诺 |
| P1–P5/primary | 0G上述体验 | 五项范围 | 范围内补齐 | approved | autoplan有限扩充，不改用户要求 |

<!-- autoplan-accepted:ceo -->
- 2D整套下载以中文面名和稳定面标识组织；矩形盒准确六面，缺面不称完整。测试六面/缺顶底/重复面/旧单源件丢失；ZIP必须清单与实际发布资产一致。
- 右侧栏保存宽度/折叠状态的新设置键，旧浮窗top/left不迁为右栏坐标；重置可恢复默认400px，窄屏不套非法宽度。测试旧localStorage、resize及当前字段/焦点不丢。
- 压缩失败项重试复用同批原件和新attempt；已成功结果不重压、不覆盖。不得复制history吞错误为空列表的行为，压缩历史加载失败显示可重试提示并保留上一有效列表。测试重复提交、部分失败重试、迟到回调。
- 运行时自动校验大小与结构后发布可下载候选；展示“大小已达标，请检查公章和小字”，不得称已验签/业务已验收。视觉检查不新增逐单签字阻断，但业务放行本功能前必须以人工核定的代表性照片PDF和带章报告验收公章、小字、骑缝章、条码、透明蒙版；未通过时不冻结150dpi/质量60为可靠政策。运行时发现内容结构/透明蒙版处理不支持则该文件失败并保留原件，不以数字质量参数替代内容完整性保证。
- 逐文件显示输入/输出大小、节省字节及百分比；passthrough为0节省；failed/unmet_target不展示伪造节省、不进达标ZIP。测试严格10,000,000边界、零节省和失败行。
- 移除草案未获范围授权的图片目标输入控件，图片默认自动压缩。R05单面PNG+ZIP是本计划暂定实施默认，最终格式偏好待gate，所有测试按这一默认说明，不把整张展开PDF视为已承诺。
- 实施先完成R06/B01.5各自可行性门，再扩展完整接线：授权后用代表照片PDF和报告验证目标体积、公章/小字/透明保真；用人工真值字段验证Illustrator内容/定位/可见性与渲染一致。失败回到本批方案选择，不能凭回退成功宣称需求已交付。当前只记录实验矩阵不执行。B01.5记录旧/新字段误报、漏报、定位正确率及人工复核时间；已核定的真差异不得新增漏报，指定OCR误报样例必须整改，未达成保持待验收。
- R05按备案查看/提交附件用图设计，保持原始印刷面比例、像素尺寸与方向，不缩略后再打包；不承诺印刷交接的CMYK/出血/刀模用途。最终gate明确PNG+ZIP与整张展开用途偏好，用户若选择其他用途则调整本批方案。
- 整批UAT按同一代表业务流程验证五项：同单取2D、照片PDF与带章报告的大小和可辨性、离页刷新历史取回、固定右栏完成疑点核对、目标原生文字样例误报改善且不增漏报；分别保留Code/L0/Windows/L2/UAT证据，未验不闭单。
- 新压缩路由采用/api/compressions/start、list/detail、retry、files/:key、zip以及终态delete，继续Hono身份校验：admin/reviewer可create，已登录可团队读取，修改/重试/删除按owner或admin且角色权限，viewer只读导出；owner写稳定身份ID，不以显示名授权。错误码和详情由一个公共投影产生；HTTP不返回私有路径、PID或原文文字日志。上传字段采用服务端分配的file_id，文件名只作展示；无文件/零字节/魔数不符/超量拒绝，路径/扩展名不能拼接进shell。
- 压缩所有子进程使用固定可执行文件+argv、不使用shell，文件名含引号/Unicode/../../不影响路径；工作目录内白名单文件，限制解码像素、PDF页数/对象数/单图解码预算、Java堆与输出/临时目录总量，递归Form XObject有visited集合与深度/对象预算。不能支持的蒙版/过滤器原样保留或失败，不解码后静默丢章。阈值在合成资源验证前仅为保守提案，资源不足拒单，不能删原件补空间。
- 压缩批次状态由全部逐文件状态确定：未全部终态保持running；全部达标/直出done，有成功有失败partial，全失败failed。重试失败项时已有成功产物仍能下载，ZIP标“下载已达标N项”并带成功/失败清单；0成功不提供空ZIP。重试/删除/下载/发布按同批串行变更围栏+产物读租约，删除先终态校验，活动下载保留其冻结文件集直至结束。测试发布先/删除先及下载先/删除先两种顺序，迟到结果不能复活墓碑。
- 观测新增compression槽与native提字阶段到现有队列/开工板和release readiness，记录任务/attempt/策略版本、输入输出字节、耗时与稳定原因码，不记录稿件内容。管理员可据错误码区分依赖缺失、资源不足、签名限制、未达大小、Agent busy/offline；业务页只给简短原因与下一步，不自动发消息。测试未知/损坏记录进入jobs_unknown，下载长流在drain内。
- 发布前在明确运维授权下预置新旧离线依赖包并校验版本/hash/许可，既有发布事务停服后不联网安装。新schema追加、旧任务惰性读取，原件不重写；关新增准入仍保留已完成产物读取。已接单后不得用不认识新job的旧版本直接回滚；先排干并保持fence，采用理解新任务记录的修复版本。回滚执行另行授权，当前只写合同和测试。
<!-- /autoplan-accepted:ceo -->

<!-- autoplan-baseline-edits:ceo {"sourceSha256":"3aefae0139e31baa8a324459b346826a047e50320b799485c30c3f82ddf9545c","replacements":[{"oldText":"图片目标大小未被用户指定，不强套PDF10MB；首版提供可选单文件目标，默认“尽量减小，保持清晰”。","newText":"图片目标大小未被用户指定，不强套PDF10MB；首版不新增目标输入控件，自动“尽量减小，保持清晰”。"},{"oldText":"R05 打样单增加“下载2D平面图”，单面PNG+整套ZIP；","newText":"R05 打样单增加“下载2D平面图”，本计划以单面PNG+整套ZIP作为暂定实施默认，最终gate可调整格式；"}]} -->

Spec attempt1: 7/10，4 issues。1发布与质量验收分层、2节省量展示补齐、3暂定格式统一、4撤销未记录图片目标输入；均属autoplan P1/P3/P6的范围内修订，待第二轮独立核对。

0H spec loop完成：2次launch，首轮4问题，第二轮9/10 PASS确认4项修复、0剩余。CEO scope summary已保存；autoplan将文件批准合并至最终gate，不在此打断。
0I时间审问：Hour1先定义资产清单/任务schema/权限；Hour2–3实现高风险PDF helper和native证据输入的合成合同；Hour4–5接队列/历史与侧栏定位；Hour6+补异常、Windows安装与人工验收清单。估算人类团队8–14工程日，CC辅助3–5工程日（跨平台/质量校准压缩有限，不承诺时限）。最大未知是PDF画质/AI私有文字映射，两者在实施早段做显式实验，失败不得用OCR降级冒充B01.5已解决。

### CEO 双声音结果与处置
Native /root/ceo_native 完成，INPUT ceo 97f02a3f338774a0c831092cad22c68b7ba0aaf9dd8c3cff239e7670c01a07b1正确，5 findings（3 high、2 medium）。N1用途→T1最终gate；N2可行性门→接受；N3业务改善指标→接受；N4工具组合比较→接受记录；N5整批退出标准→接受。外部claude-code实际调用退出1，认证401（配置认证链的xAI OAuth元数据网络请求失败），没有输出token/modelUsage，无可用外评。不改provider/模型/认证；修复应由用户处理认证或网络后再跑，不能称双模型确认。
| Dimension | Native | Claude Code | Consensus |
|---|---|---|---|
| Premises valid | 效果前提需证据 | unavailable | N/A |
| Right problem | 是，落到业务流程 | unavailable | N/A |
| Scope calibration | 五项保留，格式待定 | unavailable | N/A |
| Alternatives | 补小型组合比较 | unavailable | N/A |
| Competitive risk | 手工工具仍可能更快 | unavailable | N/A |
| Six-month trajectory | 需业务指标防空交付 | unavailable | N/A |

### CEO Section 1 Architecture
新依赖图以唯一Hono控制面为中心，压缩独立资源槽、原生文字共享Illustrator槽，两者不新建网站。发现2处接线风险：queueSnapshot/release drain尚无compression计数；提字不能借OCR槽长等Adobe。M2接受显式新槽与提字前置阶段，不建通用queue服务；10倍流量首先受CPU/Adobe单槽约束，100倍超出内部2–3人的本批预算，准入限额先拒单而非假承诺扩容。
### CEO Section 2 Error & Rescue
逐边界检查上传、候选生成、发布、下载和原生提字，映射下表10条。现有宽泛catch不可成为“压缩成功”的依据；错误类转换成稳定业务code且保留可调试日志。M3接受对unsupported、unmet_target、dependency_missing分开，原件保留与可重试条件具体化，设计中0静默critical gap，尚无实现证明。
### CEO Section 3 Security
威胁主要是上传恶意PDF解码炸弹（中概率/高影响）、任意文件下载（中/高）和原生脚本入口扩展（低/高）。M4接受固定argv、magic校验、像素/对象/时限预算、授权投影和固定Agent命令，不向浏览器暴露本地路径。无新增密钥；新压缩ownership仅稳定ID，不能套旧显示名兼容授权，原生提取不接受用户脚本。
### CEO Section 4 Data & UX
按双击提交、上传刷新、工作中离页、混合失败、已达标、空ZIP、删除下载竞态7类逐一追踪。发现缺少删除/下载与发布的共享边界，M5接受冻结清单和读租约，状态迁移需测试两个完成顺序。原始任务文件存在不等于发布成功，写manifest后公开，旧attempt和墓碑不允许复活。
### CEO Section 5 Code Quality
新增compression深模块隐藏图像/PDF进程差异，index只薄路由、jobs拥有调度写权，避免复制独立任务写者。已有HistoryPage将mockups错误catch为[]的模式会造成新类型凭空消失，本批compression拒绝复制且显示原位错误。M6采用一个状态汇总/公共投影，API/schema/UI不各自重算状态；不进行范围外全站重构。
### CEO Section 6 Tests
5条业务路径均映射可观察断言，测试图见下；真正回归是六面对应、大小边界/签名字节、误报漏报和恢复围栏，不测函数内部调用次数。2am信心用例是混合批次重启后只重试失败项并从历史下回同一hash；敌对用例是100MiB低压缩比超大像素嵌套PDF；chaos为发布前后崩溃与晚回调。M7保留合成L0+少量E2E，真实/原生标记显式授权；没有把现阶段“不执行验证”改为少测承诺。
### CEO Section 7 Performance
最慢路径预计为多页PDF重复解码、Illustrator串行打开、ZIP读取；p99当前无实测，5分钟是超时提案不是观测。内存不能只按上传大小限制，解码预算、Java堆和临时空间是必需约束；单槽只限制并发不等于总资源上限。M8接受运行前预留和候选逐一处理，不同时留8份大候选；历史列表只读摘要，不逐项打开PDF或扫资产目录。
### CEO Section 8 Observability
发现新kind未进入状态板/排干会使部署看似空闲，已纳入M2和M9。首日指标为成功/直出/未达标/限制/失败数、处理耗时、队列等待与磁盘占用，日志按job/attempt/策略联结，不写稿件文字。问题三周后可由策略版本与源件身份重建处理经过；管理员按错误code处理依赖和资源，业务只看可操作说明，不新增自动告警发送。
### CEO Section 9 Deployment
新Java/qpdf/Sharp依赖不能在当前停服流程临时安装，Agent扩展也必须带版本和脚本hash一起匹配。M10接受预置新旧离线依赖、先后兼容schema与queue readiness，禁止把Mac通过当Windows完成。rollback只在已有授权和真实drain/fence下执行；已接新单后不能盲回不认识compression的旧版本，优先前向修复。
### CEO Section 10 Trajectory
复用产物manifest、证据来源与持久job可支持后续改进，但不加入通用流程搭建器。主要债务是Java运行时交付与Adobe私有数据行为，均是本批效果所需，不向小刘暴露这些实现细节。可逆性4/5（输出副本和追加schema可撤，私有格式与宿主成本不可假装零），2项运维/兼容债务需版本化记录；六个月后是否值得由完成任务时间和误报/漏报决定。
### CEO Section 11 Design
用户路径是已有打样单下载、独立压缩入口、统一历史找回、右栏核对四个已有工作环境的自然补全，不增“AI控制中心”。加载/空/错/成功/部分失败必须都有短中文和下一步，不使用假精确百分比；大小已达标不等于签字或验签成功。M11保留品牌、40px控件与键盘焦点，右栏的具体可用尺寸和窄屏状态交后续设计评审，不用旧DESIGN浮窗覆盖用户最新要求。

### CEO 工具备选比较与研究
Layer1：优先标准PDF文字、原件保留与图片重采样，qpdf适合结构优化。Layer2：Stirling官方文档有自动目标大小模式，Adobe官方PDF选项区分保留Illustrator编辑数据；来源 https://docs.stirlingpdf.com/Functionality/Compress/ 、https://helpx.adobe.com/illustrator/using/pdf-options.html 、https://qpdf.readthedocs.io/en/stable/cli.html#optimizing-file-size 。Layer3：用户需要“可提交附件+可靠审稿证据”，高star本身不证明印章保真；结构优化与原生文字提取必须分开，压缩副本不得覆盖审稿原件。Aside readiness已通过；本轮沿用已读取官方资料，未向搜索发送私有样本。
| 候选 | 目标大小/内容 | Windows/维护 | 决定 |
|---|---|---|---|
| qpdf单独 | 结构优化，不能保证图片型PDF缩到目标 | 轻CLI | 不单独承担R06 |
| 现有PyMuPDF扩展重采样 | 少运行时；蒙版/签名/色彩仍需实现与校准 | 已有Python但许可和抽图重写风险须核对 | 备选，不未经证据替换已选方向 |
| PDFBox+qpdf小helper | 可借鉴Stirling目标迭代，需逐对象保真验证 | 多Java运行时，明确离线依赖成本 | 本计划暂选 |
| 整套Stirling服务 | 功能多而身份/端口/历史重复 | 最大集成面 | 不选 |

### Error & Rescue / Failure Modes Registry
新方法名为拟定合同，不是已存在实现；所有Test指后续计划。
| Codepath | Failure/class或稳定code | Rescue/action | 用户所见 | Test | Log |
|---|---|---|---|---|---|
| uploads compression purpose | invalid_input/413/429 | 拒绝且保留可恢复会话 | 类型/总量/稍后再传 | nil/empty/magic/limit | 是，脱敏 |
| claim/start | receipt_expired/conflict | durable claim/rollback/幂等 | 重新选择或既有任务 | 双提交/宕机 | 是 |
| PDF preflight | signed_over_limit/encrypted | 不重写原件 | 取未签名/可读原件 | byte-identical signed | 是 |
| helper launch | ENOENT/dependency_missing | 作业明确失败，可管理员修复后重试 | 压缩工具暂不可用 | stub missing version | 是 |
| candidate search | unmet_target/timeout/resource_limit | 终止本attempt安全子树，保原件 | 未达10MB/资源不足 | 阈值/预算/8轮 | 是 |
| candidate validate | content_integrity_failed | 禁发布 | 无法安全压缩 | 页数/蒙版/文字 | 是 |
| publish/retry/delete | stale_attempt/conflict/ENOSPC | 围栏/墓碑，旧回调丢弃，不删原件 | 可重试/处理中不可删 | 两序竞态/断电 | 是 |
| download/zip | asset_missing/forbidden | 禁空/残包，读租约释放 | 重新打开/无权限 | 0成功/并发删/路径 | 是 |
| native extraction | agent_busy/offline/native_mismatch | 排队或区域OCR+人工确认 | 提字等待/待人工确认 | 无字体/隐藏/坐标 | 是 |
| sidebar/history | stale_fetch/invalid_layout | 保留有效列表/夹宽/重新定位 | 重试/当前疑点不丢 | 旧存储/大字/晚请求 | 是 |
10条均规划rescue、用户可见、日志与测试；不是已测试，无静默未处理critical设计行。

### ASCII diagrams
```text
ARCH: React (download/compress/history/review)
        -> Hono :8787 [identity + receipt + public projection]
             -> jobs single writer -> compression slot1 -> Sharp / PDFBox + qpdf
             -> Illustrator slot1 -> fixed Agent/JSX -> native evidence
             -> OCR/Python compare -> human decision
             -> existing packaging -> six face assets
DATA: file -> validate -> durable receipt -> claim -> queued -> attempt staging -> validate -> manifest -> download
      nil/0/wrong magic -> reject; expired -> recover/reselect
      timeout/OOM/unsupported -> failed + original; stale attempt -> discard
      duplicate -> same job; conflict -> retry after active; partial -> successes only
STATE: queued -> running -> done|partial|failed
       failed parts -> retry(new attempt) -> running (old successes readable)
       terminal -> deleting(tombstone) -> deleted; no running->deleted/no late publish->resurrection
ERROR: helper/native -> typed code -> bounded rescue -> status + log -> actionable UI
DEPLOY: authorize/prestage offline runtimes -> drain+requests+all slots -> trusted main transaction -> L1 -> separate L2/UAT
ROLLBACK: before commit? -> journal recovery with matching runtime
          after admission? -> stop new admission+drain -> compatible forward fix; no blind old-kind rollback
UX: mockup detail -> 2D download -> /compress -> ready receipt -> batch progress
    -> leave -> history -> same batch -> ready downloads
    review list -> right sidebar -> locate bbox -> human decide -> signature gate
TEST: six-face manifest -> unit + mockup HTTP + UI download
      compression helper -> synthetic integration + byte/structure assertions
      receipt/jobs -> existing server harness + controlled pause race/recovery
      native evidence -> Python synthetic + Agent protocol fixtures; authorized Windows native later
      sidebar/history -> pure geometry tests + artifact E2E; visual UAT later
RACE A publish vs delete: [P awaits candidate] [D checks running ->409] [P manifest commit] [fresh reader correct]
RACE B delete vs late P: [terminal D writes tombstone] [P stale attempt tries commit ->reject] [fresh reader404]
RACE C download vs delete: [R acquires manifest+lease] [D tombstones record, retains leased files] [R finishes] [cleanup allowed]
RACE D delete vs download: [D tombstones first] [new R rejected] [no path reopened]
```
Diagrams涉及新计划而非代码，现有合同无本轮改过的ASCII图；旧“浮窗不挤画布”文字必须随B01.4实施同步，不把它当仍有效的设计要求。

### NOT in scope / What already exists / Dream state delta
不做：自动飞书发送（P6拒绝）、整套Stirling网站/商业engine、引数据库/通用工作流、印刷生产文件承诺、自动代签/验章、历史H1–H3三类业务（既有延后）、本轮实际试压/原生运行/发布。既有代码映射见0B与审计，不从零再造2D和历史。距12个月理想还差真实业务接受和更广真值，当前5切片不会自动申报或清掉所有历史欠项。

### Decision audit (CEO)
M2槽/排干,P5完整性；M3分错误,P1；M4权限/argv/预算,P6；M5并发租约,P1；M6深模块/单投影,P4；M7行为验收,P1；M8资源预留,P5；M9状态板,P6；M10离线依赖/回滚,P6；M11状态可访问,P1。全部为范围内mechanical auto-decisions。N2/N3/N5同属落实已确认需求，不减范围；N4比较不新增依赖。T1 PNG+ZIP用途、T2资源/质量参数留taste，未产生两声一致的User Challenge（outside缺失不能算一致）。

### CEO Completion Summary
| Field | Outcome |
|---|---|
| Mode / System Audit / Step0 | SELECTIVE EXPANSION；沿用5项、两运行时风险；2轮spec9/10 |
| Section1 Arch | 2接线风险规划修正 |
| Section2 Errors | 10 paths，0静默设计gap |
| Section3 Security | 3 threats，中/低概率、高影响，规划缓解 |
| Section4 Data/UX | 7类边界，4共享状态时序，0未处理设计项 |
| Section5 Quality | 2风险：静默列表失败/长模块，已约束 |
| Section6 Tests | diagram已写，真实证据未执行 |
| Section7 Perf | 3慢路径，实测p99未知 |
| Section8 Observability | 2缺口：新槽/错误原因，规划修正 |
| Section9 Deploy | 2风险：离线依赖/旧kind回滚 |
| Section10 Future | reversibility4/5，2债务 |
| Section11 Design | 2重点：右栏余宽/部分失败，设计阶段细化 |
| NOT scope / reuse / dream | 已写，保留历史边界 |
| Registries | 10行，0 silent critical gap；尚未实施验证 |
| TODO / scope proposals | 0新增延期；6提案5接受1拒绝 |
| CEO summary | 已保存于ceo-plans，spec9/10 |
| Outside / Native / Consensus | unavailable401 / completed5 / N/A |
| Lake score | N/A，无覆盖差异问答 |
| Diagrams / stale | 8类图与4竞态时序；0本轮已修改代码图 |
| Unresolved | T1/T2暂定偏好，外部覆盖缺失 |

### Implementation Tasks — CEO
- [ ] **C1 (P1, human: ~24h / CC: ~8h)** — 补齐压缩持久任务和历史全链路
  - Surfaced by: CEO1/4/8：新槽排干、幂等、竞态与历史错误
  - Files: apps/web/server/src/jobs.ts, apps/web/server/src/uploads.ts, apps/web/ui/src/pages/HistoryPage.tsx
  - Verify: 合成start/claim/recovery/drain/download并发两序
- [ ] **C2 (P1, human: ~24h / CC: ~10h)** — 先做原生提字可行性门和业务真值
  - Surfaced by: Native N2/N3与CEO6：不能凭OCR回退算改善
  - Files: apps/web/backend/app/pdf_ingest.py, apps/web/backend/app/text_verify.py, workers/packaging/illustrator/export_structure.jsx
  - Verify: 授权后目标字段误报修正且真差异零新增漏报
- [ ] **C3 (P1, human: ~8h / CC: ~3h)** — 明确2D产物与五项整批验收
  - Surfaced by: Native N1/N5：产物用途与完整业务流程
  - Files: apps/web/ui/src/pages/MockupPage.tsx, TODOS.md
  - Verify: 六面原像素/方向、五项UAT清单

估算按跨平台与可行性校准调整，不使用模板30倍压缩当承诺。

### Design Step 0 / 0.5 与独立评审
Methodology 1–600、601–1200、1201–1800、1801–1972完整读至EOF。对象是本计划，类型OPERATE；用户要求固定右栏与现有DESIGN品牌优先，初始完整度7/10。既有左导航280/76、≤1024折叠、≤720抽屉；品牌#805898，系统中文字体16/13，标题28；SVG优先、当前字段框、header签字沿用。全部相关维度自动评审，不用中途提问替代autoplan最终gate。
Mockup：design二进制可用，但首次variants在生成前退出2，No OpenAI API key found，requested=0、saved=0；未产出效果图、未启动比较HTTP服务、未修改认证。按skill失败降级为文字交互规格，无图像质量或用户视觉批准证据。
Codex (in-host) SUBAGENT /root/design_native完成，INPUT design 6724b9fd7402b5e9c4e37aa4f66b8dc65b93aaf03e858b2fd9846b3a3f7cba03，5项：D1混合达标措辞high；D2上传时序、D3窄屏、D4详情层级、D5回退提示各medium。均接受为P1/P5/P6范围内补齐。

<!-- autoplan-accepted:design -->
- 混合批次主操作统一“下载可用结果N项”，摘要“可用N、处理中N、未成功N”；这细化CEO的“已达标N项”为PDF专属大小语义，不能把图片成功等同小于10MB。PDF行标“小于10 MB（10,000,000字节）”及“请检查公章和小字”；图片行标“已压缩”或“已保留原件，未进一步减小”，帮助文字明确图片未设置大小目标。ZIP只含图片成功/直出与PDF大小达标/原样符合项，失败项排除；零可用不显示下载。测试混合图片>10MB仍成功但不称达标、PDF精确阈值和重试期间旧结果可下载。
- 上传时序为选文件/本地初检→点击开始→逐行分片进度→服务端确认完整receipt→建立批次/排队。点击后冻结本次文件集合并防重复提交；上传中断保留收据与成功分片，重试失败上传，不静默提交不完整集合。未开始前可移除文件；冻结后如需换集合，明确结束本次未提交上传后重新选择，不影响已建批次。离页继续仅承诺服务端已接管的批次；上传中离页提示未上传部分会中断，返回尝试恢复，浏览器缺源文件时要求重选并校验身份；过期receipt明确重新上传。测试失败分片/重复点击/离页前后/过期与重选错误文件。
- 右栏按实际内容工作区宽度W判定：扣分隔条8px后，画布至少480px且右栏至少320px才并排，即W≥808px；并排栏宽clamp(已存宽或400,320,min(560,W-488))。W<808时画布在上、问题在下，画布目标40vh并clamp到240–420px，问题区独立滚动；短视口采用页面纵向滚动，不造成不可达控件或重叠。窄屏画布旁保留当前疑点摘要及上一项/下一项；图内仍可平移缩放。窄屏不覆写桌面宽度；返回并排恢复并夹限。拖动与键盘resize后重新计算canvas rect并保持当前字段可见；折叠栏按钮留在可见区域，展开焦点回到原控件或当前疑点。默认数值为实施基线，390/1024/1440及28px大字人工可用性验收后调整，不声称已验证。
- 压缩详情顺序固定：批次摘要/主操作→简短结果与限制→文件列表。排队不给虚构ETA，逐文件区分上传和压缩；轮询首次加载显示骨架与状态文字，刷新失败保留上次数据并标“更新失败，当前为上次结果”及重试。空历史显示创建入口；无权限显示无权限；404/资产失效明确不可取回，不能伪装空成功。失败原因就地给下一步，可重试按钮仅针对可重试项；后台继续时不夺取焦点。测试空/首次加载/旧数据失效/局部失败/全部失败/重试running仍有可用结果。
- 原生提字等待放任务阶段，不与已有疑点结论混淆；回退完成后提示限定到受影响字段/区域“此区域使用OCR，请结合稿面核对”，可展开原因。全单受影响才用整单提示，不额外改变签字门槛；无定位仍能看字段和原文，不画假框。没有field可承载的页面区域用页级提示。测试等待→回退→完成、混合来源、无bbox、人工结论不丢。
- 可访问性具体落实：上传区有原生文件按钮和键盘路径；结果行/面下载有含文件或面名的accessible name；状态有文字/图标不只靠颜色，进度用低频aria-live polite批次摘要避免逐分片播报；分隔条role=separator、方向/当前宽度/键盘步进，焦点清晰。常规文字对比≥4.5:1，按钮/边界≥3:1；>=40px目标沿现有合同，大字无横向整页溢出。手工检查Tab顺序、折叠恢复、屏幕阅读状态、窄屏上下两区和下载失败反馈；本轮不做运行验证。
<!-- /autoplan-accepted:design -->

### Design Passes 1–7
1. 信息架构 8→9：新增文件压缩在打样后、历史前符合附件任务顺序；沿现有route，详情先概览再逐行。不把依赖/算法参数放业务主路径；“下载可用”修正D1与D4。
2. 交互状态 6→9：D2补清浏览器上传与服务端接管边界；D4补旧数据刷新失败；D5把局部回退限定到字段/页。失败允许用户知道做什么，不靠toast单独存信息。
3. 用户旅程 8→9：打样取2D→压缩→离页→历史结果；审核等候提字→右栏核对→现有签字。最大断点原是上传离页承诺，已明确；R05用途T1仍最终gate，不以暂定PNG冒充用户已选格式。
4. AI样式套路 9→9：工作台是单一核对/压缩任务，没有hero、渐变卡片网格、指标装饰、营销文案；使用必要表格/面清单。Mockup缺失，视觉执行分数不可确认，以上仅规格检查。
5. 设计系统 8→9：现有紫色与中文系统字体沿用，不能以通用审美规则替换品牌；仅自由浮窗与导航数目随明确用户需求更新。spacing/tokens复用既有变量，不引新组件库。
6. 响应与可访问性 6→8：D3有W阈值、两区高度、焦点/定位、旧存储迁移；补键盘/朗读/对比验收。原型和运行证据缺失，不能给10；现阶段保守暂定尺寸T3。
7. 未评分决定登记：T1 PNG+ZIP或整张展开用途、T2资源/质量参数、T3侧栏400与窄屏阈值为provisional taste。结构性补齐D1–D5自动接受，不构造新User Challenge；外部缺失不能说双声一致。

| State | 2D | 压缩/上传 | 历史 | 审稿/原生 |
|---|---|---|---|---|
| loading | 读面/补面状态 | 分片与排队独立 | 首载骨架 | 等待提字/审稿 |
| empty | 无有效面/源缺失说明 | 可键盘选文件 | 首单入口 | 无疑点沿旧流程 |
| error | 单面原因/复用补面 | 行内原因/重选或重试 | 保留旧列表+重试 | OCR回退范围提示 |
| partial | 缺面不称完整 | 可用与失败并列 | 类型加载失败明确 | 局部OCR不称整单失败 |
| success | 面名+原尺寸下载 | 大小与节省+可用下载 | 同批详情可恢复 | 人工决定/签字门保持 |

| Litmus | Native独立声音 | Primary证据 | Claude Code / Consensus |
|---|---|---|---|
| brand | 未单列 | YES：既有紫色/中文系统字体 | N/A / N/A |
| visual anchor | 画布/右栏总体合理 | YES：稿面主区域 | N/A / N/A |
| headline | 批次摘要应先行 | YES：可用/处理中/未成功 | N/A / N/A |
| one job | 旅程连贯 | YES：核对或压缩单任务 | N/A / N/A |
| cards | 未单列 | YES：有语义列表，无装饰卡网格 | N/A / N/A |
| motion | 未单列 | NOT SPECIFIED：仅现有过渡，实施尊重reduced-motion | N/A / N/A |
| premium sans shadow | 未单列 | 规格YES，视觉未验证 | N/A / N/A |

### Design Completion / Implementation Tasks
初始完整度7；六维最终9/9/9/9/9/8，overall=min=8/10（仅计划）。7 passes已覆盖，5项独立问题采纳；0完成图片；外部结果单列，不计共识。新动效非本批必要，不新增动效系统；实现若沿用过渡需尊重减少动态效果。
- [ ] **D1 (P1, human: ~12h / CC: ~4h)** — 压缩上传/结果/历史状态与PDF专属目标语义。Files: apps/web/ui/src/pages/HistoryPage.tsx, apps/web/ui/src/api.ts, proposed CompressionPage.tsx。Verify: 混合批次/上传离页/失败重试/旧数据提示。
- [ ] **D2 (P1, human: ~12h / CC: ~4h)** — 固定右栏响应布局与可访问定位。Files: apps/web/ui/src/pages/ReviewPage.tsx, apps/web/ui/src/pages/reviewDock.ts, apps/web/ui/src/styles/app.css。Verify: 三宽度/大字/键盘/当前字段与旧存储。
Design NOT in scope：新品牌/动效系统/印刷CMYK承诺，理由为用户只要求本批附件和审稿改进。What already exists：DESIGN tokens、App导航、ReviewPage定位/签字、HistoryPage行模型、上传收据。没有新延期债务，in-scope验证留任务中；TASKS JSONL已写，估算考虑交互与跨端手工验证而非固定倍率。
Claude Code SAYS (design — UX challenge)：unavailable。重新实际调用退出1，401/xAI OAuth元数据网络认证失败，session 7fba42f4-024e-48ea-a603-628a7b7ace64，input/output tokens=0、modelUsage={}。没有可用外评文字；5项native已完成，七项litmus共识均N/A。与CEO相同阻断，不更改认证/provider；后续阶段按已确认认证不可用记录missing coverage，若运行前状态有变化才重新尝试。

### DX Step 0A–0G：证据、对象与旅程
Methodology 1–600（含截断段250–385补读）、601–1200、1201–1800、1801–2119读至EOF；Hall of Fame安装alias缺文件，已从同仓实际源/Users/hutou/.gstack/repos/gstack/plan-devex-review/dx-hall-of-fame.md分别读取Pass1–8。模式DX POLISH，autoplan P6自动推导对象，不开启公共SDK或新增运维平台。
Persona：内部全栈维护者，熟悉React/TS与Python；本机迭代，需把依赖交给杭州Windows管理员。入口证据README“本机启动”、apps/web/README、UI README、package.json、dev-start.sh、Windows README；产品是内网业务应用，开发界面是现有API+受控helper/Agent协议及部署文档。容忍一次依赖准备，但不应靠猜端口、cookie格式或Windows会话才能调试业务。期望保留8787/5173、合成测试可离线运行和稳定错误码。
Developer Perspective（推演，不是人类实测）：我从README进入项目，看到它服务于供应链同事，界面和计算分开。我知道从根目录启动Hono，开发页面由Vite代理。现在要接压缩，计划列出Java、qpdf和Sharp，但我还不知道该用哪一版、哪个包负责构建helper，或缺一项时会得到什么。若我只看到压缩失败，就可能去查上传，而真正缺的是运行时。我希望先用无业务数据的样例得到一个可解释的结果，再查完整任务的状态；也希望重试不会重复压缩已有成功文件。原生文字在Windows桌面才能证明时，我需要明确本机合成通过到哪里为止，而不是被一个绿色测试误导。升级时最担心旧任务读不回以及Agent版本不配套。以上困惑从计划缺少精确安装/API合同推导，未宣称亲历报错或测得耗时。

0C benchmark：Aside readiness沿用，本轮只读research session s3n0CZk7ZnfpYoGC完成，未安装或运行工具。官方资料支持下表的接口事实，时间均未实测；跨工具起点不同，不做速度排名。
| Tool | Start→result | 时间/证据 | DX选择 | Source |
|---|---|---|---|---|
| PDFBox | Java+固定JAR→提字/渲染；压缩需本地helper | 未测，官方文档 | 3.x CLI参数不同于2.x，不能把现成CLI当目标大小压缩器 | https://pdfbox.apache.org/3.0/commandline.html ; https://pdfbox.apache.org/3.0/migration.html |
| qpdf | 固定Windows发行包→结构重写/优化 | 未测，官方文档 | 退出0/2/3区分成功/错误/警告，固定包和配套DLL | https://qpdf.readthedocs.io/en/stable/cli.html ; https://github.com/qpdf/qpdf/blob/v12.4.2/README-what-to-download.md |
| Sharp | 兼容Node+平台原生包→图像输出 | 未测，官方文档 | 单图链路；不是Windows整份PDF压缩替代品，默认输出会删元数据需显式保真 | https://sharp.pixelplumbing.com/install/ ; https://sharp.pixelplumbing.com/api-output/ |
| beian本批 | 既有开发环境已能启动+本批离线依赖包在本机→理解首份合成压缩结果 | 当前未知；方案目标≤5min，包含读指南、解包/校验/构建helper和首轮运行 | 复用现有启动和测试入口，不造公共CLI/第三服务 | README.md、scripts/dev-start.sh与本计划 |
0C自动选择Competitive目标≤5min（P5范围内开发便利），不是已达成；全新电脑从clone到依赖下载/安装另计冷启动全程，目前未知，不能排除安装耗时后宣传“从零五分钟”。无人工实测时competitive rank=UNMEASURED，不应用模板转化率数字。
0D magical moment：维护者在已配置环境用一份合成PDF得到可用结果/字节数/原件保留和清楚状态，并能通过现有API取回；最低成本载体为现有测试harness中的一个端到端合成案例+可复制指南。不新增托管playground、付费账户、公共SDK。0E采用DX POLISH。0F如下，0G时标是读文档推演不是计时。
| Stage | 开发者做什么 | 有依据的摩擦 | 处置 |
|---|---|---|---|
| Discover | 根README→docs/README→模块合同 | 本批入口尚未补，旧UI README写浮窗 | 同步文档，待实施 |
| Install | dev-start.sh检查venv/npm；Windows现有准备 | 新Java/qpdf/helper来源/版本/路径未定 | 依赖矩阵+构建/预检指南，待实施 |
| Hello World | 既有测试harness/合成文件→首批结果 | 暂无压缩样例/方法签名 | 同一接口示例覆盖首建/重发/部分重试 |
| Real Usage | UI→receipt→start→history→download | 新类型尚需合同接线 | 公共投影+完整接口表 |
| Debug | 读ApiError code/reason与任务日志 | 实际api.ts读取detail/message/code/reason；不能直接换不兼容error嵌套 | 兼容错误投影+排障责任表 |
| Upgrade | 既有release离线预检/排干 | Java/Sharp原生包、Agent协议版本新风险 | 固定发行物/能力检查/旧schema兼容 |

0G confusion log（预测）：T+0 README指出8787/5173，入口清楚；T+0:30看到dev-start可能建venv/npm，冷启动耗时未知；T+1发现新依赖只在计划，安装命令待交付；T+2需要压缩API例子，当前仅route概念；T+3知道真实AI链需Windows交互桌面，本机没有这份证据。依赖/API/错误均纳入范围内修订，不捏造实际用户放弃或超时。

### DX 双声音
Codex (in-host) SUBAGENT /root/dx_native完成，INPUT dx b5ecd84d5526e2546ee5418d6b37fcdb5434bb124569696a85270f9feeca92b1，4 medium：X1启动、X2API、X3错误目录、X4配置生效。全部接受为现有五项实现的必要合同。Claude Code SAYS (DX — developer experience challenge)：unavailable；重新检查config=enabled、CLI仍存在，上一阶段本会话实际401认证失败未修复，无新的外评调用或结果，不能把已失败声音算完成。
| Dimension | Native | Claude Code | Consensus |
|---|---|---|---|
| Getting started<5min | X1缺具体路径/未知 | N/A | N/A |
| API/CLI naming | X2需精确调用合同 | N/A | N/A |
| Errors | X3责任/链接未闭合 | N/A | N/A |
| Docs | X1–3需要例子 | N/A | N/A |
| Upgrade | 无独立高危，版本合同需细化 | N/A | N/A |
| Dev environment | X4参数/生效时机 | N/A | N/A |

<!-- autoplan-accepted:dx -->
- S3/S4交付时提供可复制开发指南：依赖矩阵（Mac/Windows、Node/Sharp原生包、Java/PDFBox helper/qpdf、版本/hash/许可、下载来源与离线预置位置）、helper可复现构建入口与能力预检。受控可执行文件发现顺序为已验证的显式本机配置→固定依赖包路径→开发环境PATH候选再校验版本；HTTP请求不提供工具路径。预检失败不领receipt。沿现有dev-start与TESTING入口，首个合成用例展示输入/结果字节、任务状态/原因码、原件保留；没有Illustrator仍能跑协议/融合合成测试，明确不能据此验收原生链。新命令在实施前不伪装已存在；指南例子需随实现实际复制执行核对。内部已准备环境首个理解性成功目标≤5min，计入读指南/解包/校验/helper构建/运行；冷启动安装全程另记，不新增遥测或定时任务。
- 压缩接口固定为POST /api/compressions/start {receipt_id}；首次201、相同owner/receipt重复200并返回同id；GET /api/compressions返回安全摘要列表；GET /api/compressions/:id返回详情；POST /api/compressions/:id/retry带expected_revision，仅重试服务器确认可重试的失败项，首次202，已受理的同revision重发返回同attempt，失配409；GET /api/compressions/:id/files/:key及GET /api/compressions/:id/zip导出已发布白名单产物；DELETE /api/compressions/:id仅终态且权限符合，返回200 JSON供既有fetchJson消费，活动作业409。精确上传session/complete接口沿现有uploads，receipt绑定服务端完整file_id集合，不接受客户端重写源路径、目标字节或owner。详情公共投影提供revision、terminal、counts、files、can_retry/retryable_file_ids、can_delete，客户端据此停止轮询和显示动作；权限最终仍由服务器复核。测试首建、重复start、同revision重试重发、部分成功继续下载、并发冲突、越权与JSON错误。
- 公共错误保留现有api.ts支持的顶层detail/code/reason，新增retryable/action/doc_ref为可选字段，不换成客户端不认识的嵌套error。以单一错误目录维护code→HTTP/任务失败原因→简短文案→可重试性→操作主体→修复步骤→仓库文档锚点；覆盖上传/运行/发布/恢复/下载/native回退，管理员才看受控诊断。业务页只展示问题与下一步，不暴露路径/PID/稿件内容；unknown_error保留task/attempt关联。qpdf退出3单列warning，不能只凭非零泛化失败或零退出认定合格；候选结构/大小校验仍必需，未知或影响内容的警告不发布。测试错误目录与前端投影对应、依赖缺失、超时、receipt过期、权限、签名阻断、fence及缺产物。
- 最小配置合同区分不可绕过的PDF<10,000,000字节、身份/原件/内容完整性，与受校验的资源预算/依赖路径/已验证策略档位。本机非密钥配置沿settings overlay，首版不给业务高级参数页；并发上限暂固定1，文件/批次/像素预算在既定上限内可收紧，放宽需先资源采证并更新版本化策略。质量/候选轮数/超时以有版本的政策清单管理，拒绝无效范围和未校准质量档位。每个attempt保存实际生效策略快照/版本及工具版本，配置变更仅作用新attempt，不能改在途子进程或已发布结果；诊断可显示安全数值/来源，私有路径只留受控本机日志。测试无效配置、运行时改设置、重试新策略、旧结果仍可读；当前150dpi/60只是假设，不标已校准。
<!-- /autoplan-accepted:dx -->

### DX Passes 1–8 与评分
1. Getting Started 5→7：10应为维护者拿到固定依赖包后按指南取得首份可解释结果且有真实计时。目前dev-start入口存在，新helper命令/依赖未交付，X1作为实施任务；不凭指南目标给9–10分。理想三步：按固定矩阵准备和构建→沿现有TESTING启动合成用例→检查结果及API示例，预计≤5min仅待实测。
2. API/CLI/SDK 6→8：10应为一次示例即可正确做start/查询/幂等重试，类型与服务端一致。X2补方法/status/revision/terminal，公共SDK不适用；后端helper只收固定job input/output，不接受任意shell命令。未有运行例子是剩余差距。
3. Errors 7→9：10应为每条错误能据问题/原因/修复定位且经过故障注入。三路径对照：receipt既有400/upload_receipt_expired→“暂存已过期，请重选上传”；新dependency_missing当前无实现→412/管理员预置兼容包且不领receipt；新native fence当前只原则→受影响区域OCR提示、管理员按既有Session1恢复合同处理，普通重试不能清fence。X3错误目录、文档锚点和日志关联补齐，尚未注入验证。
4. Docs 6→8：10应为2分钟内从docs/README找到完整指南、三套API例子和错误项。同步已有入口与合同，旧“浮窗不挤画布”随实施纠正；不另建文档站或交互playground。复制执行验证仍欠。
5. Upgrade 8→9：10应为新旧任务与依赖组合均经Windows预演。沿发布合同离线预检/排干与向前兼容修复，新增依赖版本矩阵和Agent能力协商；无需codemod因为追加schema和局部设置重置。不能拿Mac通过证明Windows升级。
6. Dev Environment 6→8：10应为Mac/Windows都有受控构建和合成开发，不需真实客户稿/线上密钥。X1/X4明确路径和策略快照；Sharp平台原生包不可直接从Mac复制到Windows，Java/qpdf只在离线依赖准备阶段；native测试隔离宿主，类型复用。尚缺实机证据。
7. Community 8→8：10对内部项目意味着维护入口/源码许可/固定上游来源清楚。复用GitHub仓库和既有协作，不新增论坛/插件市场/收费服务；采用库的LICENSE/NOTICE随发行保存。无需为评分加公共社区功能，暂无额外任务。
8. Measurement 5→7：10应为目标起点与首个有用结果的人工实测可复现。使用实施验收一次性计时表（OS、冷/暖前提、步骤、失败、结果），不启遥测/周期自动任务；目标≤5min未测。后续真实体验与本计划比对，不把合成执行毫秒数当人的上手时间。

| Dimension | Before→after | Prior/trend | Gap to10 |
|---|---|---|---|
| Getting Started | 5→7 | 无本分支先前DX，N/A | 安装/计时实证 |
| API/CLI/SDK | 6→8 | N/A | 运行三例 |
| Error Messages | 7→9 | N/A | 故障注入 |
| Documentation | 6→8 | N/A | 复制可执行 |
| Upgrade Path | 8→9 | N/A | Windows预演 |
| Dev Environment | 6→8 | N/A | 跨平台证据 |
| Community | 8→8 | N/A | 上游版本/许可冻结 |
| DX Measurement | 5→7 | N/A | 人工计时 |
Overall平均6.4→8.0（计划判断）；TTHW当前unknown→目标≤5min，Competitive tier=UNMEASURED；magical moment已设计，未执行。Principles：零摩擦/上下文示例/动手体验有计划但有证据gap；错误可操作/默认与受控调整已覆盖；无独立critical。没有为评分添加SDK、公共CLI、社区平台或监控定时任务。

### DX Implementation Checklist / Tasks
- [ ] 依赖矩阵/构建/只读能力预检/合成首例与≤5min目标实测（未知不是通过）。
- [ ] 首建、重复start、部分重试三套带既有身份上下文的可复制示例；禁止在指南写真实cookie/密钥。
- [ ] 错误目录每项有问题/原因/修复主体/文档锚点，类型与公共投影覆盖。
- [ ] 升级文档、策略快照、老记录读取、Mac与Windows原生依赖分别验证。
- [ ] docs/README入口、README新tab/右栏文案与CHANGELOG随实施同步。
模板一键全新安装/公共免费层/社区搜索/LSP/多语言SDK/插件生态不适用内部本批，未新增承诺；现有TS、GitHub CI、TESTING/harness、角色/错误解析复用；无需codemod迁全库。NOT in scope：托管playground/遥测/新公共开发者产品，理由为五项内部业务范围。没有新增延期TODO。
- [ ] **X1 (P1, human: ~12h / CC: ~4h)** — 依赖矩阵、可复制开发指南与策略快照。Surfaced by native X1/X4、Pass1/5/6。Files: docs/contracts/jobs.md, scripts/windows/README.md, apps/web/server/src/settings.ts, proposed compression helper build。Verify: 无宿主合成路径、依赖缺失、配置变更不影响旧attempt。
- [ ] **X2 (P1, human: ~8h / CC: ~3h)** — 压缩API合同、公共错误目录与三套例子。Surfaced by native X2/X3、Pass2/3/4。Files: apps/web/ui/src/api.ts, docs/contracts/architecture.md, docs/contracts/jobs.md, proposed compression routes。Verify: receipt重发/revision重试/混合成功下载及错误投影。

## Engineering Review — Phase 3
Methodology: autoplan-eng-methodology-FRNveC/methodology.md，2215行已完整加载。固定输入autoplan-eng-hUsbTD/eng-implementation.md，INPUT eng dc76f6d1412a020c88cfa3c7f50b3251ca89b6b35a33c3aefbea2bc93d41a2d8。

### Step 0 范围、复用与复杂度
五项范围保持，不以复杂为由砍需求。已有：print_faces持久补面、uploads分片/receipt/claim/recovery、jobs执行槽/围栏、Hono身份、HistoryPage、reviewDock/canvasZoom、Python单OCR与标准PDF层、Session1 Agent固定脚本协议。新增只在这些边界接入；不新建队列框架、数据库、HTTP服务、OCR引擎或COM宿主。
静态复杂度估算（不是diff实测）：约18–24个既有生产文件修改，6–9个新生产文件，12–18个测试文件新建/扩展，5–8份现有文档同步。主要新增为compression routes/model/runner、CompressionPage、PDFBox helper构建与入口、native JSX及证据融合；优先模块函数，不设计新继承层。路线内复杂度来自持久化/原生宿主而非UI。拒绝完整Stirling服务和通用插件化，保留既有单写者，按业务模块拆文件。资源预算与原子持久化复用本地成熟模式，因此不再为已有模式引入新基础设施研究；新增库能力沿DX的官方PDFBox/qpdf/Sharp调研，版本兼容尚未实测。
NOT in scope：修改审核规则全集、全页重绘PDF、移除签字门、历史欠项自动销账、公开SDK、生产操作。历史21主题不关闭。

### 双声音
Codex (in-host) SUBAGENT /root/eng_native 已完成，输入hash匹配，4个P2：逐文件中间态缺失、慢下载占租约、积压磁盘预算、直出前加密/损坏检查。全部接受，见E1–E4。
Claude Code SAYS：unavailable。CLI仍存在；CEO和Design两次真实调用均401认证失败、空result/modelUsage。本阶段认证条件未修复，没有重复无效外调，不伪造第三次完成；沿明确降级策略保留native评审。config探测未返回可判定开关值，不将其解释为禁用。外部缺失不计共识。
| Dimension | Native | Claude Code | Consensus |
|---|---|---|---|
| Architecture sound | 需补状态/预算 | unavailable | N/A |
| Test coverage sufficient | 需补4组边界 | unavailable | N/A |
| Performance risks | 下载/磁盘有缺口 | unavailable | N/A |
| Security threats | PDF预检需补齐 | unavailable | N/A |
| Error paths | 待实施补齐 | unavailable | N/A |
| Deployment risk | drain期限需明确 | unavailable | N/A |

### Architecture、Code Quality、Performance findings
以下是计划缺口，不声称现有产品已有这些新功能的线上bug。可信度0–10。
| ID | 来源/级别/置信 | 证据原文与位置 | 决定与验证 |
|---|---|---|---|
| E1 | native/P2/9 | 输入计划“未全部终态保持running”，但逐文件只列终态；jobs.ts:289已有queued/running计数 | 明确file queued/running及批次派生优先级；两任务竞争槽/重试恢复测试 |
| E2 | native/P2/9 | 输入“活动下载保留其冻结文件集直至结束”未限速/断开边界 | 加限额、连接超时和finally；排干逾期失败关闭发布，不能删除仍被读的文件 |
| E3 | native/P2/9 | 输入单批100MiB但未限定已接单积压；uploads.test.ts:224只覆盖暂存receipt预算 | 预算覆盖上传到队列源件，原子预留/转移/恢复；并发最后配额/磁盘不足测试 |
| E4 | native/P2/9 | 输入“PDF小于硬上限直接原字节输出”先于加密校验 | 先做有界可读性/结构预检，再原字节直出；小于限额但损坏/需密码也不能成功 |
| E5 | primary/High/10 | tasks.ts:133 `copyFileSync(tmp, dest);`，mockupAtomicWrite.test.ts:124 `MOCKUP_ATOMIC_WRITE_WINDOWS_DURABILITY_PROVEN, false` | 新任务不复用copy覆盖；同目录rename失败保持旧记录，Windows耐久另行举证 |
| E6 | primary/High/10 | region_ocr.py:46 `if page_modes.get(page_n) == "live_text": continue`；compare_core.py:70 `return max(1, min(n, 4))` | 原生候选不得把混合页改live_text；保留全页单OCR后区域融合及现有审稿页数上限 |
| E7 | primary/P2/9 | queueSnapshot.ts实际位于jobs.ts:289仅ocr/blender/illustrator；enqueue只对mockup单独加载 | 显式扩展kind/统计/恢复/health/readiness；native预阶段完成后才领OCR，不双占、不饿死打样 |
| E8 | primary/P2/8 | 现有HistoryPage轮询和加载列表模式；新计划ZIP/图片解码增加成本 | 只读安全摘要、复用失效缓存/原件hash、单槽预算、流式ZIP，禁止每次轮询读PDF或重打包 |

Architecture依赖（新增标+）：
```text
React: Mockup(2D) / Review(sidebar) / +Compression / History
                 | existing auth + Hono :8787
     uploads(receipt/claim) -> +compression routes -> jobs唯一后续写者
                                      |                 |
                            +durable manifest       +compression slot
                            +budget/lease fence        |-> Sharp
                                      ^                |-> PDFBox helper -> qpdf
                                      |--------- validated immutable files
compare/rework -> native pre-stage -> existing Illustrator slot/Agent -> +fixed JSX
                | candidate JSON(hash/page/visibility)                     |
                +-> existing Python PDF ingest -> native gate -> OCR fallback -> +evidence fusion
                                                   -> matching -> human review
jobs/active download leases -> queueSnapshot + drain + recovery + readiness
```
耦合：共享jobs.ts、uploads.ts、api类型与入口由一个集成所有者按切片合入；渲染/压缩互不替换源件。扩容暂不分布式，单实例沿现有进程归属/启动围栏；不宣称本地Promise锁支持多进程并写。安全：稳定owner、固定argv与可执行文件、受控目录、无路径泄露、白名单资产key、格式/对象/解码预算、受限Java堆。无新增外网OCR/LLM供应商。
Code quality：只抽共享错误投影/状态派生及确有两个调用方的低层原子写；不直接套mockup错误码到compression。现有atomicReplaceJobJson的受控根/同目录rename/清理模式保持，抽取如扩大回归面则在compression存储中窄实现并注明受限重复，禁止顺手重构tasks.ts。旧浮窗几何helper只有不再使用的部分随实现退役，不删标注/跳过字段等仍用逻辑。
Performance：没有数据库N+1；目录摘要遍历随历史增长，新增类型沿现有索引/缓存更新语义，轮询不扫描产物内容。压缩/图片按文件串行、临时候选及时清理、ZIP流式背压，避免整批Buffer；页数/对象/大图解码/递归都有限额。hash只在接管/校验必要点算；native缓存sourcehash+extractor+坐标版本，不复用不同源。排队busy不占OCR；FIFO共享AI槽且等待有截止/明确回退，不无限让打样饥饿。压缩具体CPU/内存/时长上限须合成与Windows采证，当前没有性能通过结论。

<!-- autoplan-accepted:eng -->
- E1：逐文件状态增加queued/running，终态为succeeded/passthrough/unmet_target/unsupported/failed。批次只要当前有文件running即running；无running而有queued为queued（可以保留以前的成功结果）；全部终态才聚合done/partial/failed。这个规则细化并取代CEO“未全部终态保持running”的概括。重试仅失败且可重试项转queued、产生新attempt/revision，既有成功产物不变；旧revision重发幂等，迟到结果按attempt/revision拒收。新增两任务竞争单槽、重试排队、混合终态、重启恢复测试。
- E2：下载使用冻结的已发布文件清单、流式背压与读租约；连接取消/异常/结束均在finally释放。初版暂定每身份2条导出、全局4条，120秒无进展或15分钟绝对期限终止该连接并给可重下载提示，数值纳入策略配置及后续合成验证。drain拒绝新导出，已开始导出按同一有限策略结束；发布等待达到既有期限则中止该次发布并保持旧服务，不为发版强删文件/终止Illustrator。删除先写墓碑阻止新读取，已有读租约归零才清理。测试慢客户端/断开/超时/删除竞态/排干不能误报空闲。
- E3：准入预算从上传session、未消费receipt到已接管queued/running源件连续计费，不得在claim时先释放再重新申请。沿既有每owner400MiB、全局1GiB暂存预算扩展计数范围，并限制已接管非终态批次每owner8/全局64；这些是初版保守限制，不改变单批20文件/100MiB。同一预算锁下检查并预留，源件从receipt转入job只转移不双计，崩溃恢复用持久记录重建保留量；临时/输出空间另有每任务上限和磁盘安全余量。每轮写候选前复核真实空闲空间，其他任务占盘时失败保留原件。终态退出积压配额但仍占真实磁盘，不自动清历史。并发最后额度、claim各崩溃点、服务重启、他任务占盘均需故障注入验证。
- E4：PDF先有界检查魔数、可打开性/结构及安全限制，再判断体积。需密码或加密权限不允许读取/处理的文件为unsupported，不收密码；已可合法读取但有修改限制且原件小于10,000,000字节可以逐字节原样直出，不解密/重写；超标且不能修改明确失败。损坏/不可读即使小也不称成功。数字签名原件小于限额只原字节通过，不代表验签；超标禁止自动重写。测试小文件损坏/需密码/只读原样/签名hash及恰等于10,000,000的边界。
- E5：新增compression持久化不得使用tasks.replaceFile的Windows copyFile覆盖分支。采用已存在mockupAtomicWrite的受控路径、独占同目录临时文件、写完fsync、rename原子替换模式；rename失败旧记录不变并清理本次临时文件，不先删旧文件、不copy覆盖。任务接受顺序为保留claim→源件可靠安置并hash→queued清单持久成功→commit claim→入队；重启按source_receipt识别已接单，避免重复/丢原件。产物先落不可变attempt目录，再发布manifest；失败不能暴露半份产物。墓碑与revision比较同串行写者。测试每个崩溃点/rename失败/旧attempt/删除后迟到；Windows原子可见性与断电耐久分开报告，不把Mac测试当耐久证明。
- E6：新增AI候选不改现有标准PDF层分类为live_text。混合页继续现有整页单OCR，再对通过hash/坐标/可见性验证的候选做区域证据融合；无法确证关联保留两路来源并标疑点，不能覆盖成“一致”，不加第二OCR引擎。沿现有compare_core的1–4页夹限与当前用户选择，记录实际处理页/画板覆盖，不把审稿暗改为全报告审查；PDF压缩保留全部页是独立合同。原生候选缓存绑定源件、提取器和坐标映射版本；旧人工结论不刷新覆盖。测试少量AI活字+图片文字、隐藏/遮挡/旋转/裁剪/超出处理页及真差异不得新增漏报。
- E7：扩展JobKind、enqueue返回类型、queueSnapshot、health/readiness/drain与reclaim所有分支，损坏/未知compression记录计unknown并阻止误判空闲。native预阶段通过现有共享Illustrator单槽及固定capability命令取得JSON；忙时排队不占OCR，确认能力不兼容/等待截止时带原因回退，未知宿主执行状态保留fence。默认native等待上限暂定120秒，从任务进入native等待计时，受策略快照约束；不用强杀解锁。共享槽FIFO兼顾打样，native完成释放后再领OCR，恢复不能同时重放AI与OCR。新增模拟busy/能力不符/晚到/重启/FIFO/排干测试；真实Session1验证另行授权。
- E8：任务list/detail从持久摘要及安全投影提供状态，轮询不读取PDF内容、不重算hash、不重生成ZIP。图片/候选按文件串行并有解码/堆/磁盘上限；导出流式且冻结文件集。复用现有测试harness和依赖注入，纯几何与状态函数测试不新建测试专用产品接口。新增功能的测试分组按下述图及独立测试计划；真实样稿、Windows宿主、画质和业务效果均独立验收，本轮只静态规划。
- E9（本轮native补充）：Sharp的元数据探针、解码、ICC处理与编码全部在独立图片worker子进程执行，Hono不加载Sharp解码业务；使用固定入口和受限JSON/文件协议，所有native分配/缓存/专属后代计入MR5压缩工作组预算。进程异常或超预算只结束已确认属于本attempt的压缩工作组，写稳定worker_resource_limit/worker_interrupted原因，不影响Hono、审稿或共享Illustrator；隔离/限制能力不足则预检拒绝。G11/17补worker崩溃、堆外超预算、主服务仍能health/读取历史与处理其他作业、无遗留子进程。
- E10（本轮native补充）：新压缩列表采用有界摘要索引与分页，GET /api/compressions支持limit默认50最大100及不透明cursor，响应{items,next_cursor,has_more,index_revision,partial}；按(created_at,id)倒序唯一排序，cursor绑定筛选条件与扫描上界，新建项在刷新首屏时纳入，删除项略过不造成跨页重复。可重建摘要索引随单写者持久提交更新，不每次HTTP扫描/解析全部job正文；索引无可信快照则明确503/index_rebuilding，不伪空成功，损坏记录计unknown并给partial诊断。UI沿现有历史筛选和分页区域接入：压缩筛选在服务端应用创建人/日期条件，变更筛选重置cursor；“全部”按相同全序惰性合并既有task/mockup/upload摘要与压缩分页，只补足所需可见窗口及一页预取，未加载完不得拿本地子集当总数/全部创建人/全部结果。通过服务端索引提供过滤后的计数和创建人摘要；游标页锚点支持返回已访问页，未有锚点的深页跳转不暗中抓全库，沿分页区域显示顺序翻页/继续载入及未知总量提示。详情轮询只读当前job，历史只增量刷新当前可见活动项，压缩页缓存至多3页并按索引版本失效；不顺手重写旧类型存储/引数据库。新增分页边界、同时间戳、过滤后旧记录、并发新增/删除、索引崩溃重建、混合来源完整排序/计数、损坏记录与10倍合成记录量每次响应≤100项且不全量读job的测试。此为原R07/E8的有界读取细化，实施同步api.ts类型与既有历史加载状态，不新增业务功能。
<!-- /autoplan-accepted:eng -->

### Section 3 完整测试路径图与处置
已专门读取jobs.ts:289–355、jobs.test.ts:193–225/1183–1230、uploads.test.ts:346–388、mockupAtomicWrite.test.ts:91–130、region_ocr.py:1–105及其完整相关测试、compare_core.py:65–73/216–273、reviewDock.test.ts:27–83。无产品测试执行。现有测试保护旧行为，不能记作新路径已覆盖。
```text
NEW CODE PATH                                      NEW USER FLOW
G01 face manifest/download/ZIP [GAP unit+HTTP]      取单面/整套2D [GAP E2E]
G02 old job repair/missing source [GAP integration] 老单补面/错误原位 [GAP E2E]
G03 sidebar width/storage/canvas rect [GAP unit]    拖宽/窄屏/大字/字段定位 [GAP E2E+manual]
G04 focus/keyboard/actions [GAP E2E]               折叠返回/签字/人工结论 [GAP E2E]
G05 upload freeze/resume/receipt [GAP HTTP]         双击/断网/离页重选 [GAP E2E]
G06 byte and slot reservations [GAP integration]  积压拒单/资源原因 [GAP HTTP+UI]
G07 start claim/commit/recovery [GAP integration]  响应丢失同单恢复 [GAP E2E]
G08 queued/running/retry/revision [GAP unit+HTTP]   部分失败只重试失败项 [GAP E2E]
G09 PDF preflight/passthrough [GAP helper]          小文件/损坏/签名/密码提示 [GAP UI]
G10 PDF bounded candidate validation [GAP helper]  10MB边界/未达标/公章 [GAP fixture+manual]
G11 Sharp format/color/orientation [GAP fixture]   图片成功/无收益/动图拒绝 [GAP UI]
G12 publish/tombstone/late result [GAP integration] 不下载半成品/删除不复活 [GAP HTTP]
G13 stream leases/ZIP/timeout [GAP integration]    重名/断开/慢下载/重试 [GAP E2E]
G14 history projection/stale poll [GAP HTTP+unit]   刷新/旧结果/无权限/空列表 [GAP E2E]
G15 Agent capability/shared slot [GAP protocol]    原生提字等待/回退原因 [GAP E2E+Windows]
G16 candidate hash/coverage/fusion [GAP pytest]     混合页/无bbox/隐藏字疑点 [GAP gold+manual]
G17 readiness/drain/restart [GAP integration]      在途任务不被升级截断 [GAP Windows]
G18 complete five-item journey [GAP E2E+UAT]        同业务稿完成本批全流程
```
18组全部为新合同缺口，全部决定随功能实施补齐；没有为了降低数目删测试。G01/02扩jobs-print-faces、mockup-files、mockupReadFaces测试；G03/04扩canvasZoom并以sidebar几何替换已失效的浮窗位置断言；G05–08/12/13/17扩uploads/jobs harness并新增compression-http/storage/runner测试；G09/10新helper合成PDF夹具；G11图片夹具；G14扩historyRows/HistoryPage；G15扩illustratorAgent/jobs协议；G16扩test_pdf_ingest/test_region_ocr及新增native证据融合测试；G18沿现有合成浏览器架构，真实UAT另列。
LLM/prompt scope：本批不改prompt/模型调用，故没有新增LLM eval套件。B01.5需要业务金标对比（旧/新误报、漏报、定位、人工复核时间）；不能用“无LLM改动”免掉识别质量评估。若实现阶段触及prompt，按受影响现有eval追加，不在当前承诺不存在的套件。CRITICAL保护：签字权限/人工结论/hits_v2、图片字不漏检、原件不丢、原子可见、发版不截断宿主。现有源码字符串断言不足以证明行为，扩行为断言，不靠快照重复实现。
测试计划：[独立QA测试计划](/Users/hutou/.gstack/projects/weiweity-beian/hutou-codex-r05-r07-autoplan-eng-review-test-plan-20261009-131323.md)。实际命令实施时按TESTING分组；先相关node:test/pytest/helper单元，UI build后浏览器，Windows合成→授权真实稿L2/UAT。未运行L0/build/质量门/Windows/真实稿。

### Failure modes registry
| Failure | Recovery/error | Planned proof | Critical silent gap after amendment |
|---|---|---|---|
| upload中断/receipt过期 | 原位续传/重选，不建半批 | G05/07 | no |
| 配额/磁盘耗尽 | 429/资源原因，保留原件 | G06 | no |
| crash于claim/manifest/commit | 持久认领对账，不重复接单 | G07/12 | no |
| PDF损坏/加密/签名/未达大小 | 明确unsupported/unmet，不能伪成功 | G09/10 | no |
| 公章/文字结构失真 | 校验失败保留原件；视觉金标门 | G10/UAT | no，尚未验证 |
| 图片超像素/动画/无收益 | 拒绝或原样直出 | G11 | no |
| 原子rename失败/晚到/删除 | 保留旧值，围栏拒收 | G12 | no |
| 慢流/断开/ZIP失败 | 有限连接/finally/重下载 | G13 | no |
| 轮询失败/权限/文件失效 | stale数据+明确错误 | G14 | no |
| Agent busy/版本不符/未知归属 | 等待/回退/围栏，禁强杀 | G15/17 | no |
| AI隐藏文字/局部活字/错坐标 | 候选拒收/保留OCR疑点 | G16 | no |
| 新job未计排干/依赖不兼容 | readiness阻断，发布失败保留旧服务 | G17 | no |
“no”表示已有计划恢复与测试映射，不代表代码已修复或验证通过。

### 顺序与并行策略
实施先做两个技术可行性门（R06画质/目标、B01.5原生映射），同时可推进R05与右侧栏；确认技术路线后完成压缩+历史垂直切片、原生融合，再整批回归。5个依赖lane：A资产2D、B审稿UI、C压缩/历史、D原生证据、E集成/Windows/UAT；A/B/C/D模块内可并行，E顺序。jobs/uploads/api共享文件由集成负责人串行接线，C/D不能各自改不同排干定义。这里只规划并行，不创建实施agent或额外工作树。

### Engineering tasks / completion
- [ ] E1 (P1, human ~16h / CC ~6h)：持久状态、claim/配额、原子发布及恢复。Files: jobs.ts/uploads.ts/proposed compression.ts。验证G06–08/12/17。
- [ ] E2 (P1, human ~8h / CC ~3h)：PDF预检和有限下载租约。Files: proposed compression runner/routes/helper。验证G09/10/13。
- [ ] E3 (P1, human ~16h / CC ~6h)：原生预阶段、混合证据和共享AI槽。Files: jobs.ts/illustratorAgent.ts/compare_core.py/region_ocr.py。验证G15–17和金标。
- [ ] E4 (P2, human ~12h / CC ~4h)：批次回归与低成本状态投影。Files: HistoryPage.tsx/proposed compression tests。验证G01–18，禁止拿合成替代真实稿。
Completion Summary：Scope accepted as-is；Architecture 3（E1/E5/E7）、Code Quality 1（E6）、Test 18 gaps（全部纳入）、Performance 3（E2/E3/E8），另PDF错误语义1（E4），独立问题共8不重复累计；NOT in scope/What already exists/图/测试artifact/失败登记已写。Critical silent gaps=0（计划层）；TODOS新增延期主题0；本阶段unresolved=0，继承T1产物格式、T2资源默认值待最终gate。Outside unavailable；parallelization 5 lanes，4可并行/1顺序；Lake Score N/A（autoplan自动决策，无用户评分回答）。工程状态issues_open：实施与验证未完成，不能宣称ENG CLEAR。

### Decision Audit Trail — Eng
| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| E1 | eng | 明确queued与running | auto-approved | P1/P5 | 与实际调度一致 | 所有非终态running |
| E2 | eng | 有限读租约/排干失败保留服务 | auto-approved | P1/P5 | 不让慢连接阻塞无界 | 强杀宿主/删正在读文件 |
| E3 | eng | 连续原子配额与恢复 | auto-approved | P1/P4 | 防无限积压和瞬时穿透 | 只限单批 |
| E4 | eng | 小PDF也先可读预检 | auto-approved | P1 | 体积不代表有效文件 | 损坏文件成功 |
| E5 | eng | 同目录rename失败不copy覆盖 | auto-approved | P1/P4 | 复用已有可靠模式 | 原样套tasks.replaceFile |
| E6 | eng | 保留混合页OCR再融合 | auto-approved | P1/P2 | 不扩大漏检/页数范围 | AI有字即全页skip |
| E7 | eng | 共享AI预阶段/排干全覆盖 | auto-approved | P1/P4 | 复用宿主与单写者 | 另建COM/第三服务 |
| E8 | eng | 摘要轮询/流式有界 | auto-approved | P4/P5 | 控内存与IO | 每轮扫描/重压 |
| EG | eng | 18组测试随功能补齐 | auto-approved | P1 | 各有用户损失与真实分支 | 仅快乐路径/源码字符串断言 |

## Final Gate — APPROVED（2026-10-09）
这是本次规划评审产物，未完成事项仍以TODOS为唯一主源；下面任务是本批实施映射，不新增独立状态台账。五项同批保持，无User Challenge。决策按最终行为去重为38项：35项自动、3项taste已由用户确认；前文M/P/N/X/E别名映射至以下相同行为，不重复计数。未修改已接受的实现条件。

### Canonical Decision Audit Trail
| ID | Phase | Decision | Classification | Principle | Rationale / Rejected |
|---|---|---|---|---|---|
| CEO-01 | ceo | 2D整套下载以中文面名和稳定面标识组织；矩形盒准确六面，缺面不称完整 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| CEO-02 | ceo | 右侧栏保存宽度/折叠状态的新设置键，旧浮窗top/left不迁为右栏坐标；重置可恢复默认400px，窄屏不套非法宽度 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| CEO-03 | ceo | 压缩失败项重试复用同批原件和新attempt；已成功结果不重压、不覆盖 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| CEO-04 | ceo | 运行时自动校验大小与结构后发布可下载候选；展示“大小已达标，请检查公章和小字”，不得称已验签/业务已验收 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| CEO-05 | ceo | 逐文件显示输入/输出大小、节省字节及百分比；passthrough为0节省；failed/unmet_target不展示伪造节省、不进达标ZIP | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| CEO-06 | ceo | 移除草案未获范围授权的图片目标输入控件，图片默认自动压缩 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| CEO-07 | ceo | 实施先完成R06/B01.5各自可行性门，再扩展完整接线：授权后用代表照片PDF和报告验证目标体积、公章/小字/透明保真；用人工真值字段验证Illustrator内容/定位/可见性与渲染一致 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| CEO-08 | ceo | R05按备案查看/提交附件用图设计，保持原始印刷面比例、像素尺寸与方向，不缩略后再打包；不承诺印刷交接的CMYK/出血/刀模用途 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| CEO-09 | ceo | 整批UAT按同一代表业务流程验证五项：同单取2D、照片PDF与带章报告的大小和可辨性、离页刷新历史取回、固定右栏完成疑点核对、目标原生文字样例误报改善且不增漏报；分别保留Code/L0/Windows/L2/UAT证据，未验不闭单 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| CEO-10 | ceo | 新压缩路由采用/api/compressions/start、list/detail、retry、files/:key、zip以及终态delete，继续Hono身份校验：admin/reviewer可create，已登录可团队读取，修改/重试/删除按owner或admin且角色权限，viewer只读导出；owner写稳定身份ID，不以显示名授权 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| CEO-11 | ceo | 压缩所有子进程使用固定可执行文件+argv、不使用shell，文件名含引号/Unicode/../../不影响路径；工作目录内白名单文件，限制解码像素、PDF页数/对象数/单图解码预算、Java堆与输出/临时目录总量，递归Form XObject有visited集合与深度/对象预算 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| CEO-12 | ceo | 压缩批次状态由全部逐文件状态确定：未全部终态保持running；全部达标/直出done，有成功有失败partial，全失败failed | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| CEO-13 | ceo | 观测新增compression槽与native提字阶段到现有队列/开工板和release readiness，记录任务/attempt/策略版本、输入输出字节、耗时与稳定原因码，不记录稿件内容 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| CEO-14 | ceo | 发布前在明确运维授权下预置新旧离线依赖包并校验版本/hash/许可，既有发布事务停服后不联网安装 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| DESIGN-01 | design | 混合批次主操作统一“下载可用结果N项”，摘要“可用N、处理中N、未成功N”；这细化CEO的“已达标N项”为PDF专属大小语义，不能把图片成功等同小于10MB | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| DESIGN-02 | design | 上传时序为选文件/本地初检→点击开始→逐行分片进度→服务端确认完整receipt→建立批次/排队 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| DESIGN-03 | design | 右栏按实际内容工作区宽度W判定：扣分隔条8px后，画布至少480px且右栏至少320px才并排，即W≥808px；并排栏宽clamp(已存宽或400,320,min(560,W-488)) | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| DESIGN-04 | design | 压缩详情顺序固定：批次摘要/主操作→简短结果与限制→文件列表 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| DESIGN-05 | design | 原生提字等待放任务阶段，不与已有疑点结论混淆；回退完成后提示限定到受影响字段/区域“此区域使用OCR，请结合稿面核对”，可展开原因 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| DESIGN-06 | design | 可访问性具体落实：上传区有原生文件按钮和键盘路径；结果行/面下载有含文件或面名的accessible name；状态有文字/图标不只靠颜色，进度用低频aria-live polite批次摘要避免逐分片播报；分隔条role=separator、方向/当前宽度/键盘步进，焦点清晰 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| DX-01 | dx | S3/S4交付时提供可复制开发指南：依赖矩阵（Mac/Windows、Node/Sharp原生包、Java/PDFBox helper/qpdf、版本/hash/许可、下载来源与离线预置位置）、helper可复现构建入口与能力预检 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| DX-02 | dx | 压缩接口固定为POST /api/compressions/start {receipt_id}；首次201、相同owner/receipt重复200并返回同id；GET /api/compressions返回安全摘要列表；GET /api/compressions/:id返回详情；POST /api/compressions/:id/retry带expected_revision，仅重试服务器确认可重试的失败项，首次202，已受理的同revision重发返回同attempt，失配409；GET /api/compressions/:id/files/:key及GET /api/compressions/:id/zip导出已发布白名单产物；DELETE /api/compressions/:id仅终态且权限符合，返回200 JSON供既有fetchJson消费，活动作业409 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| DX-03 | dx | 公共错误保留现有api.ts支持的顶层detail/code/reason，新增retryable/action/doc_ref为可选字段，不换成客户端不认识的嵌套error | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| DX-04 | dx | 最小配置合同区分不可绕过的PDF<10,000,000字节、身份/原件/内容完整性，与受校验的资源预算/依赖路径/已验证策略档位 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| ENG-01 | eng | E1：逐文件状态增加queued/running，终态为succeeded/passthrough/unmet_target/unsupported/failed | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| ENG-02 | eng | E2：下载使用冻结的已发布文件清单、流式背压与读租约；连接取消/异常/结束均在finally释放 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| ENG-03 | eng | E3：准入预算从上传session、未消费receipt到已接管queued/running源件连续计费，不得在claim时先释放再重新申请 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| ENG-04 | eng | E4：PDF先有界检查魔数、可打开性/结构及安全限制，再判断体积 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| ENG-05 | eng | E5：新增compression持久化不得使用tasks.replaceFile的Windows copyFile覆盖分支 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| ENG-06 | eng | E6：新增AI候选不改现有标准PDF层分类为live_text | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| ENG-07 | eng | E7：扩展JobKind、enqueue返回类型、queueSnapshot、health/readiness/drain与reclaim所有分支，损坏/未知compression记录计unknown并阻止误判空闲 | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| ENG-08 | eng | E8：任务list/detail从持久摘要及安全投影提供状态，轮询不读取PDF内容、不重算hash、不重生成ZIP | auto-decided | P1/P4/P5，保持五项完整、复用现有边界 | 见本阶段完整处置和测试；拒绝缺失此合同的原草案 |
| A-MODULE | ceo | 小型helper接现有服务 | auto-decided | P4/P5 | 避免额外身份/部署边界；拒绝整套独立网站 |
| A-NOTIFY | ceo | 不增加自动飞书通知 | auto-decided | 授权边界 | 无发送需求；拒绝P6扩项 |
| A-TEST | eng | 补齐18组新合同测试 | auto-decided | P1 | 防用户损失；拒绝仅快乐路径 |
| T1 | ceo/design | 暂定各面PNG＋整套ZIP | taste approved | 用途决定产物 | 替代：整张展开图，会增加展开布局与导出验收 |
| T2 | ceo/dx/eng | 暂定资源、超时、质量参数，采证后冻结 | taste approved | 先有界接入 | 替代：更高容量/更强压缩，要补资源与画质证据 |
| T3 | design | 右栏默认400px、320–560px可调，窄屏上下分区 | taste approved | 优先稿面与连续核对 | 替代：更宽/更窄，影响稿面可读性；真实界面验收后调整 |

### Cross-phase themes
- CEO/Design/Eng：目标是可提交且可读的附件，不能只报压缩率；混合批次成功语义要准确。
- CEO/DX/Eng：接管、持久状态、重试、恢复、下载和排干必须成为同一条链。
- CEO/Design/Eng：原生文字只是候选证据；混合图像不能漏审，业务金标决定是否改进。
- Design/DX/Eng：正确的错误信息和下一步，比隐藏失败或空列表更重要。
- CEO/DX/Eng：Windows依赖和Session1是实际交付条件；本机静态判断不替代现场证据。

### Deferred to TODOS.md
本次新增延期项0。原有21主题保持，新增R05–R07后总计24；B01.H1–H3继续待确认/排期，不混入压缩。本轮不验证，不关闭任何主题。

### Implementation Tasks (aggregated across phases)
聚合按当前分支、最近5个commit、各阶段最新run_id筛选，仅精确相同任务去重，共11条。可能重叠：C1/E1/E2/D1/X2共享压缩；C2/E3共享原生文字；C3/E4共享整批验收。它们是同一交付的不同验收要求，不能把小时简单相加作为工期；实施按五个切片合并。标注proposed或当前不存在的路径为预计落点，实施时可在现有模块边界内调整。

- [ ] **C1 (P1, human: 24h / CC: 8h) — compression** — 补齐压缩持久任务和历史全链路
  - Surfaced by: ceo-review — CEO1/4/8：新槽排干、幂等、竞态与历史错误
  - Files: apps/web/server/src/jobs.ts, apps/web/server/src/uploads.ts, apps/web/ui/src/pages/HistoryPage.tsx
- [ ] **C3 (P1, human: 8h / CC: 3h) — delivery** — 明确2D产物与五项整批验收
  - Surfaced by: ceo-review — Native N1/N5：产物用途与完整业务流程
  - Files: apps/web/ui/src/pages/MockupPage.tsx, TODOS.md
- [ ] **C2 (P1, human: 24h / CC: 10h) — native-text** — 先做原生提字可行性门和业务真值
  - Surfaced by: ceo-review — Native N2/N3与CEO6：不能凭OCR回退算改善
  - Files: apps/web/backend/app/pdf_ingest.py, apps/web/backend/app/text_verify.py, workers/packaging/illustrator/export_structure.jsx
- [ ] **D1 (P1, human: 12h / CC: 4h) — compression-ui** — Complete upload, result and history states
  - Surfaced by: design-review — Design native D1 D2 D4; mixed size semantics and upload ownership
  - Files: apps/web/ui/src/api.ts, apps/web/ui/src/pages/HistoryPage.tsx, apps/web/ui/src/pages/CompressionPage.tsx
- [ ] **D2 (P1, human: 12h / CC: 4h) — review-sidebar** — Implement responsive fixed sidebar and evidence states
  - Surfaced by: design-review — Design native D3 D5; geometry, focus and local fallback
  - Files: apps/web/ui/src/pages/ReviewPage.tsx, apps/web/ui/src/pages/reviewDock.ts, apps/web/ui/src/styles/app.css
- [ ] **E2 (P1, human: 8h / CC: 3h) — compression** — PDF预检与有限下载租约
  - Surfaced by: eng-review — E2 E4
  - Files: apps/web/server/src/compression.ts
- [ ] **E1 (P1, human: 16h / CC: 6h) — compression** — 补齐持久状态原子配额与恢复
  - Surfaced by: eng-review — E1 E3 E5 E7
  - Files: apps/web/server/src/jobs.ts, apps/web/server/src/uploads.ts
- [ ] **E3 (P1, human: 16h / CC: 6h) — native-text** — 原生预阶段与混合页证据融合
  - Surfaced by: eng-review — E6 E7
  - Files: apps/web/server/src/jobs.ts, apps/web/server/src/illustratorAgent.ts, apps/web/backend/app/compare_core.py, apps/web/backend/app/region_ocr.py
- [ ] **X2 (P1, human: 8h / CC: 3h) — compression-contract** — Specify API examples and actionable error catalog
  - Surfaced by: devex-review — DX native X2 X3
  - Files: apps/web/ui/src/api.ts, docs/contracts/architecture.md, docs/contracts/jobs.md
- [ ] **X1 (P1, human: 12h / CC: 4h) — runtime-docs** — Document fixed dependencies and snapshot effective policy
  - Surfaced by: devex-review — DX native X1 X4
  - Files: docs/contracts/jobs.md, scripts/windows/README.md, apps/web/server/src/settings.ts
- [ ] **E4 (P2, human: 12h / CC: 4h) — integration** — 整批测试和低成本历史投影
  - Surfaced by: eng-review — E8 Section3
  - Files: apps/web/ui/src/pages/HistoryPage.tsx

### Pre-gate verification
CEO全部11节与registry、Design7 passes、DX8维、Eng完整4节与18组测试图/独立QA artifact均已形成。4个native review完整结束且输入hash匹配；2次spec收敛至9/10。各阶段close packet完整读取并与源需求/接受行为比较后发布。报告记录T3未在Eng完成摘要重复列出，此处补齐为第三个继承偏好，未新增实现条件。
缺失覆盖：外部claude-code前两次401、后两阶段沿未修复认证状态标unavailable；视觉mockup生成因未配置API key未产出，已采用文字布局评审，不能视作视觉验证。无测试执行/真实稿/Windows/生产证据。本次纯文档检查不表示产品验收。

### User approval
2026-10-09 用户对最终方案确认问题答复：“认可方案，按这些默认值落地”。问题明确此次确认仅针对方案，保留“先不验证”，不包含发布授权。APPROVED；不表示功能已实现或验收。前文各阶段的provisional是历史评审状态，以本条为最终偏好决议。外部评审和视觉mockup缺失已告知，仍如实保留。

### GSTACK REVIEW REPORT — 初轮已批准的历史快照
| Review | Trigger | Runs this batch | Status | Findings |
|---|---|---|---|---|
| CEO | /autoplan → CEO | 1（spec 2轮） | 方案审查完成，用户已批准 | native5；spec9/10；范围保持 |
| Design | /autoplan → Design | 1 | 方案审查完成，用户已批准 | native5；计划评分7→8/10；视觉未验证 |
| DX | /autoplan → DX | 1 | 方案审查完成，用户已批准 | native4；计划评分6.4→8.0；TTHW未测→目标≤5min |
| Eng | /autoplan → Eng | 1 | ISSUES OPEN，方案已批准，实施与验证待完成 | native4＋primary4；18组测试缺口已纳入 |
| Outside | claude-code wrapper | CEO/Design各1次；DX/Eng未重复失败调用 | unavailable，不能记作PASS | 401认证失败，无模型输出；模型身份未知 |

OUTSIDE COVERAGE：host=codex；provider=claude-code；CEO/design/dx/eng均unavailable；native四阶段完成，问题数5/5/4/4。无双模型共识或CROSS-MODEL结论。
VERDICT：APPROVED。用户确认“认可方案，按这些默认值落地”。T1各面PNG＋整套ZIP、T2保守参数后续采证冻结、T3右侧栏400px初版均获方案批准；未扩大到本轮验证或发布。工程问题已转成实施要求，工程验证尚未CLEAR。实际实现与工程复核仍需完成，未进入ship。
NO UNRESOLVED DECISIONS


## Manual external feedback reconciliation — 2026-10-09
来源：用户手动转交xAI评审，输入hash f8d639799320b1dba8098a902681c46b296f9418fab2b8d6b293bdfb0b581f03与原最终实施快照一致。模型名Grok 4.7是转交文本自述，未独立核实；不改写为CLI完成，也不回填四阶段外评全部通过。原文保存在仓库外的manual-xai-feedback-20261009.txt。
受影响为工程算法/错误分类/资源实施细节与测试计划，API形状、用户入口、五项范围和既定偏好不变；复用已完成CEO/Design/DX，按autoplan仅重跑最后工程阶段。第1次修订周期。原eng无baseline-edits记录，无需移动；其既有接受条款完整保留。

| Feedback | 判断 | 处置 |
|---|---|---|
| R-01 High | 确证标准需细化，不能据bbox盖过图像字；要求与OCR字面一致会挡住纠错 | 修改后接受MR1；保留证据与规则链，不强求OCR一致 |
| R-02 High | 副本与可证明关闭未明确；现有Agent已有禁杀/faulted机制 | 接受MR2，复用宿主；JSON完成不等于安全关稿 |
| R-03 High | 可见章与电子签名判别需明文 | 接受并细化MR3，空签名域不当已签；未知状态不重写 |
| R-04 Medium | 9.8MB可能被误当第二目标 | 接受MR4，9.95MB合格即停 |
| R-05 Medium | 解析预算缺初值 | 接受MR5；qpdf附带建议按命令区分修正为MR5a |
| R-06 Medium | 原先要求错误目录，但未给逐类重试条件 | 接受MR6，不新建第二套错误源 |
| R-07 Low | 像素与EXIF关系待明确 | 接受MR7；原件直出例外保留hash |

已核对：uploads.ts:125回执TTL为30分钟；auth.ts:40 reviewer含create；compare_core.py既有1–4页夹限；text_verify.py:517既有合并按页保留OCR，不具备本批新候选判据。export_structure.jsx在finally关闭前可写result，因此新增提字必须区分候选完成/关闭完成；已有Agent idle/busy/faulted与管理员恢复不应重建。现有命令并无已验收的native提字能力。CodeGraph索引不可用，采用定点源码读取，未重建。
官方依据：qpdf[退出码](https://qpdf.readthedocs.io/en/stable/cli.html#exit-status)与[密码探测](https://qpdf.readthedocs.io/en/stable/cli.html#option-requires-password)明确命令差异；Sharp[autoOrient](https://sharp.pixelplumbing.com/api-operation/#autoorient)会按EXIF转像素并移除标签，XMP需另处理；PDFBox[签名字段](https://pdfbox.apache.org/docs/2.0.13/javadocs/org/apache/pdfbox/pdmodel/interactive/form/PDSignatureField.html)与[签名字典/字段API](https://pdfbox.apache.org/docs/2.0.13/javadocs/org/apache/pdfbox/pdmodel/PDDocument.html)区分字段与实际签名（这是2.x概念证据，3.x具体接口按锁定版本验证，非实施版本选择）。

### Amendment Decision Audit
| ID | Phase | Decision | Classification | Principle | Rationale/rejected |
|---|---|---|---|---|---|
| MR1 | eng | 可追溯证据融合/冲突判据 | auto | P1/P2 | 不吞真差异；拒绝bbox覆盖、拒绝强求错误OCR一致 |
| MR2 | eng | 实体副本/关闭确认/faulted保留 | auto | P1/P4 | 不写原件、不重建宿主；拒绝有JSON即闲 |
| MR3 | eng | 区分签名与可见章 | auto | P1 | 保证报告能尝试且不毁签名；拒绝字符串判签 |
| MR4 | eng | 首个合格候选立即停 | auto | P1/P5 | 不无谓降质；拒绝硬追9.8MB |
| MR5 | eng | 补未校准资源初值 | auto | 已批准T2/P1 | 可编码有界策略；拒绝无界预检 |
| MR5a | eng | 命令级退出码/警告版本化 | auto | P1/P5 | 官方语义；拒绝所有命令套一张表 |
| MR6 | eng | 有条件重试矩阵 | auto | P1/P4 | 单错误源；拒绝无限盲重试 |
| MR7 | eng | 重编码方向归一/直出原样 | auto | P1 | 避免重复旋转；拒绝原件强制改写 |

### Engineering re-review — primary sections and independent result
沿用已完整读取的autoplan-eng-methodology-FRNveC/methodology.md（2215行）进行受影响工程复核。固定新checkpoint为autoplan-eng-Dc668g/eng-implementation.md；新native输入2c1e51c9329c9b1340b7de338d686a6550fb1a165d0cdab27b6a1011096287e1匹配，独立eng_manual_feedback完整结束。未发现P0/P1，2个P2（Sharp隔离、长期列表有界读取）接受为E9/E10，不启动实施agent。

Step0范围：五项不减；复用uploads/既有Agent/原子写/现有HistoryPage分页与筛选。源码证据是text_verify.py:517按页合并、export_structure.jsx:1292先commitResult后finally关闭、illustrator-agent.ps1:221依据围栏/锁判busy与faulted、HistoryPage.tsx:74一次读全列表后客户端分页、既有api公共投影。复杂度增量：图片独立worker入口、可重建compression摘要索引（可与storage同模块），约2个生产文件以内，3–5处测试扩展；不为此新增数据库/通用任务服务。

Architecture图（其余初轮图继续有效）：
```text
Hono/control -> durable compression job -> dedicated worker group
                                         |-> isolated Sharp probe/decode/encode
                                         |-> bounded PDF preflight/helper/qpdf
               job commit -> summary index -> bounded cursor pages -> history merge
source hash -> private physical copy -> shared AI slot -> candidate JSON
                                            -> close acknowledgement + bridge exit
                                            -> release slot only when proven safe
AI candidate + OCR + rendered evidence -> field-source association -> existing rules
```
Architecture：MR2/E9将共享宿主与可终止压缩worker严格分开；MR1只做证据输入，不改签字规则。安全：实体副本、固定路径、解析前进程预算；fence不可被普通重试清除；受限job才可终止。所有读结果仍经身份校验，索引只含安全摘要。
Code quality：重试目录为唯一来源；qpdf按具体子命令适配退出码；不在前端再写一份原因分类；自动方向处理只有一个入口。MR3用结构解析不搜字符串，空签名域/Stamp不误判；MR4有一条明确停止规则，不创建额外策略引擎。

Section3测试复核：本轮专门读取test_pdf_ingest.py:344–387、illustratorAgent.test.ts:191–218/253–282、HistoryPage.test.ts及页面加载/分页、mockupAtomicWrite.test.ts:1–100。初轮G01–G18全部保留；以下是新增边界，现有测试均不能替代。未执行测试。
```text
NEW/REFINED CODEPATH                         USER FLOW                         GAP / proof
MR1 identity/conflict/render association -> 不把真差异盖成一致              pytest+gold G16
MR2 copy/hash/result-vs-close/faulted     -> 回退后不阻塞/重放未知宿主       protocol+Windows G15/G17
MR3 signature-vs-stamp/unknown           -> 普通带章报告仍可尝试/签名保留   helper fixtures G09
MR4 first-valid-candidate stop           -> 9.95MB成功且不继续降质          helper G10
MR5 bounded preflight/native JSON       -> 超限明确失败不拖垮服务          worker injection G06/G09/G15
MR5a command-specific exit codes        -> 不把可读加密探测结果误报        process adapter G10
MR6 retryability + repair prerequisites -> 修复后可重试、坏原件不盲重试     HTTP+UI G08
MR7 pixel/EXIF/XMP/passthrough           -> 手机照片方向正确且不重复旋转     image fixtures G11
E9 isolated Sharp process               -> 图片异常时历史/审稿仍可用       integration G11/G17
E10 index/cursor/filter/merge            -> 旧压缩单可找回，翻页不丢不重     HTTP+UI G14
```
10组细化全部随实施补测试，无仅验证实现内部字符串的新测试；复用已有test hooks，不新开测试专用HTTP端点。没有新增prompt/LLM调用，LLM eval范围不变；MR1仍须金标误报/漏报/定位/人工时间对比。G14新增分页不新增独立业务入口；API类型与错误示例随实施同步，既有DX单错误源/可复制示例要求保持。测试artifact更新同一QA路径的Addendum章节，初轮G18五项业务串联不删。Tests to Retire保持仅旧浮窗几何候选，其他不删除。

Performance：Sharp不在Hono native堆内解码；峰值预留在start/recovery一致，PDF页数/对象统计之前仍有OS预算；日志/JSON有字节上限。MR4避免无效继续编码，E10列表每次返回≤100且不每次读全job，索引重建一次与请求链隔离。量化吞吐/内存/真实页数适用性仍未知，数值不等于已验证。

Failure registry delta：
| Failure | Recovery/error | Proof | Silent critical gap |
|---|---|---|---|
| AI框盖图片字/缺字体 | 保留证据与疑点 | G16反例 | 0（计划） |
| JSON已写但关稿未完成 | native_close_unconfirmed，保留围栏 | G15/17 | 0（计划） |
| 签名未知/只有Stamp | 分别拒重写/普通处理 | G09 | 0（计划） |
| 达标后仍追9.8MB | 第一合格候选停 | G10 | 0（计划） |
| 预检解码爆量/超大JSON | 受控子进程或JSX协作失败 | G06/09/15 | 0（计划） |
| qpdf特殊码误分类 | 命令级适配 | G10 | 0（计划） |
| 不可重试或未修复 | can_retry=false/409 | G08 | 0（计划） |
| 图片方向双转 | EXIF/XMP归一；原样例外 | G11 | 0（计划） |
| Sharp崩溃 | 专属worker结束、Hono存活 | G11/17 | 0（计划） |
| 索引损坏/分页遗漏 | 重建/partial可见，不假空 | G14 | 0（计划） |

What already exists/NOT in scope沿初轮；本轮不更改运行时合同现状、不修认证路由、不试压/跑宿主/生产操作。TODO延期新增0，仍24主题。并行策略仍4个模块lane＋1个串行集成lane，共享jobs/api接线由一个实施所有者处理。Lake Score N/A，无新用户偏好题。

ENG DUAL VOICES：历史手动xAI只审旧hash，7条；新native完成当前hash，2条P2。Architecture/Test/Performance/Security/Errors/Deployment六维均为单声当前复核＋旧版外部反馈输入，不能计current native+outside confirmed，Consensus=N/A。CLI outside仍unavailable，未因手动贴回标completed，也不再调用已知失败认证。
Completion Summary：Scope accepted as-is；Architecture 3（MR1/MR2/E9），Code Quality 3（MR3/MR6/MR7），Test图10组delta并保留18组总图，Performance 3（MR4/MR5/E10）；9个主问题组，qpdf MR5a是MR5附带修正，不重复计；critical silent gap0只表示有恢复与测试计划。新增deferred0，unresolved product choices0；工程状态issues_open（未实施/验证）。外部手动反馈已逐条处置，新native2项已转实施义务，无未处理高优先级方案问题。

| ID | Phase | Decision | Classification | Principle | Rationale/rejected |
|---|---|---|---|---|---|
| E9 | eng | Sharp全部隔离到worker | auto | P1/P5 | 避免唯一服务被native解码拖垮；拒绝Hono内直接解码 |
| E10 | eng | 有界索引/分页与正确历史合并 | auto | P1/P4 | 长期保留可找回；拒绝每次全盘扫描或假完整列表 |

### Revised final state — external feedback handled
原五项范围、三项已批准偏好和不验证/不发布边界保持。新增10项工程自动决策（MR1–MR7含MR5a、E9/E10），没有新增产品偏好或删项挑战，沿已有批准完成技术细化，不重新索取同一授权。初轮38项加本轮10项，共48个决策记录（45自动＋3已批准偏好），实施任务精确聚合13条；任务之间有重叠，不能简单相加工时。新增延期主题0。
跨评审共同关注仍是稿面真实性、可恢复任务、共享宿主安全及有界资源；手动反馈强化这些条件，没有改成另一个产品。未验证风险完整保留：PDF画质、公章、小字、字体/原生映射、Windows原子可见性和耐久性、Session1、资源阈值、固定许可版本、五项UAT。

### Implementation Tasks — latest aggregation
以下取代初轮聚合快照用于本批实施映射；当前未完成状态仍只在TODOS维护。

- [ ] **C1 (P1, human: 24h / CC: 8h) — compression** — 补齐压缩持久任务和历史全链路
  - Surfaced by: ceo-review — CEO1/4/8：新槽排干、幂等、竞态与历史错误
  - Files: apps/web/server/src/jobs.ts, apps/web/server/src/uploads.ts, apps/web/ui/src/pages/HistoryPage.tsx
- [ ] **C3 (P1, human: 8h / CC: 3h) — delivery** — 明确2D产物与五项整批验收
  - Surfaced by: ceo-review — Native N1/N5：产物用途与完整业务流程
  - Files: apps/web/ui/src/pages/MockupPage.tsx, TODOS.md
- [ ] **C2 (P1, human: 24h / CC: 10h) — native-text** — 先做原生提字可行性门和业务真值
  - Surfaced by: ceo-review — Native N2/N3与CEO6：不能凭OCR回退算改善
  - Files: apps/web/backend/app/pdf_ingest.py, apps/web/backend/app/text_verify.py, workers/packaging/illustrator/export_structure.jsx
- [ ] **D1 (P1, human: 12h / CC: 4h) — compression-ui** — Complete upload, result and history states
  - Surfaced by: design-review — Design native D1 D2 D4; mixed size semantics and upload ownership
  - Files: apps/web/ui/src/api.ts, apps/web/ui/src/pages/HistoryPage.tsx, apps/web/ui/src/pages/CompressionPage.tsx
- [ ] **D2 (P1, human: 12h / CC: 4h) — review-sidebar** — Implement responsive fixed sidebar and evidence states
  - Surfaced by: design-review — Design native D3 D5; geometry, focus and local fallback
  - Files: apps/web/ui/src/pages/ReviewPage.tsx, apps/web/ui/src/pages/reviewDock.ts, apps/web/ui/src/styles/app.css
- [ ] **E2 (P1, human: 8h / CC: 3h) — compression** — PDF预检与有限下载租约
  - Surfaced by: eng-review — E2 E4
  - Files: apps/web/server/src/compression.ts
- [ ] **E1 (P1, human: 16h / CC: 6h) — compression** — 补齐持久状态原子配额与恢复
  - Surfaced by: eng-review — E1 E3 E5 E7
  - Files: apps/web/server/src/jobs.ts, apps/web/server/src/uploads.ts
- [ ] **E5 (P1, human: 16h / CC: 6h) — compression-native-contract** — 落实手动外评MR1-MR7与补充测试
  - Surfaced by: eng-review — manual xAI R01-R07
  - Files: apps/web/backend/app/text_verify.py, apps/web/server/src/jobs.ts, apps/web/server/src/compression.ts
- [ ] **E3 (P1, human: 16h / CC: 6h) — native-text** — 原生预阶段与混合页证据融合
  - Surfaced by: eng-review — E6 E7
  - Files: apps/web/server/src/jobs.ts, apps/web/server/src/illustratorAgent.ts, apps/web/backend/app/compare_core.py, apps/web/backend/app/region_ocr.py
- [ ] **X2 (P1, human: 8h / CC: 3h) — compression-contract** — Specify API examples and actionable error catalog
  - Surfaced by: devex-review — DX native X2 X3
  - Files: apps/web/ui/src/api.ts, docs/contracts/architecture.md, docs/contracts/jobs.md
- [ ] **X1 (P1, human: 12h / CC: 4h) — runtime-docs** — Document fixed dependencies and snapshot effective policy
  - Surfaced by: devex-review — DX native X1 X4
  - Files: docs/contracts/jobs.md, scripts/windows/README.md, apps/web/server/src/settings.ts
- [ ] **E6 (P2, human: 12h / CC: 4h) — compression-runtime** — 隔离图片worker并限制历史读取
  - Surfaced by: eng-review — native E9 E10
  - Files: apps/web/server/src/compression.ts, apps/web/ui/src/pages/HistoryPage.tsx
- [ ] **E4 (P2, human: 12h / CC: 4h) — integration** — 整批测试和低成本历史投影
  - Surfaced by: eng-review — E8 Section3
  - Files: apps/web/ui/src/pages/HistoryPage.tsx

## GSTACK REVIEW REPORT
| Review | Runs this batch | Status | Findings/coverage |
|---|---|---|---|
| CEO | 1 | 已批准范围，复用 | 五项同批保持，无新范围挑战 |
| Design | 1＋交互原型补交 | 原型已生成并做局部预览检查；待用户视觉反馈 | 右栏/上传/混合结果/历史/2D 下载已可预览；不等于真实界面验收或外评完成 |
| DX | 1 | 复用单错误目录/版本策略合同 | 新错误条件与列表投影已补到工程接口及QA；开发体验仍未实测 |
| Eng | 2 | ISSUES OPEN：方案义务已补，代码/验证待做 | 本轮手动外评7条＋独立native2条；10组测试边界补充 |
| Manual outside | 1 | 已收件、核对旧hash并逐条处置 | 用户转交xAI；Grok 4.7为文本自述；仅方案审查 |
| CLI outside | CEO/Design各1次失败 | unavailable | 401，未把手动结果改记为CLI完成 |

OUTSIDE COVERAGE：手动评审针对f8d639799320b1dba8098a902681c46b296f9418fab2b8d6b293bdfb0b581f03；新native已审2c1e51c9329c9b1340b7de338d686a6550fb1a165d0cdab27b6a1011096287e1；吸收两项native补充后最终快照f3f4f27c513b4fa76354dcb9eb94c706a1e4893a5620d7a32091806246452f6b已经主审完整读回核对。最新修订未再次送外部模型，不声明同版双声共识。
VERDICT：已完成本轮反馈核实与方案修订，保留既有批准范围，无未处理高优先级方案问题。工程实现、测试、真实稿、Windows与发布仍未完成；本轮仅文档/静态证据，不是上线许可。
NO UNRESOLVED DECISIONS

## 设计缺口补交 — 2026-10-09

用户要求继续补齐可视化设计，并允许直接在 Codex 展示。本轮沿已批准默认值提供交互原型，未修改产品代码、Figma 锁定稿或已批准的工程实施条款。原先图像生成工具缺少 API key 的失败记录保留；本次以本地交互原型补足可看、可操作的设计材料，不记作原工具恢复或设计阶段外评完成。

原型位于当前会话的仓库外目录：`/Users/hutou/.codex/visualizations/2026/10/08/01a11a80-1290-78c0-9cb2-4cf23b1a3bbf/beian-design-preview.html`。仅含合成稿面、示例文件名称/大小/状态及已有品牌 logo，不读取用户 PDF、不连接业务 API、不提交人工结论、不生成真实压缩文件。压缩大小不可作为真实稿效果证据。

覆盖：右侧核对栏默认 400px（按实际可用宽度夹限）、拖动/键盘调宽、收起恢复、字段联动、局部 OCR 提示和人工结论；混合图片/PDF 结果、签名超限的更换原件路径、上传与服务器接管阶段；统一历史类型/时间/生成人筛选及返回同批结果；打样单 2D 各面 PNG 与整套 ZIP 的入口示意。提供左右/上下原文对照的局部布局探索，但不因此改变已批准默认值。窄屏采用上下分区和导航抽屉。

证据层级仅为隔离原型：浏览器检查原型内容宽度 320/390/736/1024/1440 下四个页面无整页横向溢出；点击疑点、修改结论、折叠恢复、错误项阻止签字、批次结果与历史往返、上传阶段和面下载文案联动均通过；浏览器无脚本异常。人工查看桌面审稿、压缩、390 窄屏及深色审稿截图。检查记录与截图在同目录，记录名 `beian-prototype-checks.json`。这是静态数据交互预览，不是产品 L0/L1、真实 PDF、Windows、Illustrator、UAT 或生产发布证据。

材料已补交，用户视觉反馈尚未收到。实现时仍需落地真实滚动/数据/权限/持久化和既定测试，视觉原型不覆盖全部异常状态，也不替代外部设计专项评审；已有文字方案批准继续有效。

## 原型第二版：历史检索与连续审稿 — 2026-10-09

用户认可产品/界面评审建议，并要求按该逻辑生成新版原型。保留原视觉方向和 400px 右栏默认值，新增的检索与连续审稿要求归入 R07/B01.4；这次授权与交付是原型设计，产品代码、工程接口和真实效果验收尚未完成。上一节“视觉反馈尚未收到”是首版补交时的历史状态；用户现已认可调整方向，不将其扩张为新版成品或真实稿验收。

第二版位于同一仓库外目录的 `beian-workflow-preview.html`，首版保留。历史页有 64 条明确标注的合成记录，按时间倒序、每页 10 条；关键词匹配品名、批次名称及批次内原文件名，显示命中文件；支持类型、适配类型的状态、生成人、全部/常用/自定义日期、清除筛选与空结果恢复。批次默认名称采用文件名摘要。进入详情返回后保留查询条件和页码，并定位回原记录。桌面按列对齐压紧行距，窄屏重排。

审稿页用 24 个合成疑点（初始 20 个待确认）展示长地址、全成分与提示段落；支持“只看待确认”、分组疑点目录、下一待确认、离页后恢复选中项与备注。桌面问题内容在右栏内滚动，底部前后项操作持续可见；窄屏上下排列，稿面旁保留当前字段与前后项。没有示意定位的字段明确要求整面核对，不伪造框。压缩列表成功行收紧，失败原因保留展开展示；真实 PDF 前后预览仍为后置建议，未纳入本轮原型或当前交付承诺。

检查证据：`workflow-prototype-checks.json`，同目录保留历史列表、搜索命中、长文本与窄屏截图。已检查关键词命中子文件/跨日期、自定义日期、类型关联状态、空结果恢复、实际翻页及返回保持、24 项目录分组、跳过已处理项、无定位提示、审稿进度保留，以及 320/390/736/1024/1440 内容宽度下四页无整页横向溢出、无脚本异常。全部是隔离原型内的合成数据检查，不能作为服务端检索完整性、万条性能、产品测试或用户业务验收证据。

实施衔接：关键词检索需覆盖全部有权限的记录及子文件摘要，不能只在当前页面或已加载子集搜索；筛选/分页/混合类型计数须保持同一口径，并继承 E10 的有界读取要求。本次新增检索语义需要在产品实施时补齐接口和验证，先前工程外评快照没有自动覆盖这些增补。不新建主题，不宣称本次完成了设计外评。

## R05 最新澄清：完整净版展开稿与打印折盒 — 2026-10-09

用户指出此前对 2D 的理解不完整：原六面平面图保留，在“正面”左侧新增“2D展开图”。核心产物是进入 3D 之前的同一 `.ai` 完整净版展开稿，供下载打印后手工折成对应 3D 盒型。以本节与已更新的 TODOS/R05 为最新范围；前述原外评记录、偏好表和快照中排除整张展开图/PDF、仅按备案附件看图的判断是历史结论，已被此次明确要求补充，不能继续限制本批交付。

导出条件：与当前任务的源稿身份/版本及已确认完整结构绑定；在同一毫米坐标基础上保留各面相对位置、比例、方向，以及原稿具有的粘口、舌片和上下封口。净版隐藏刀线、折线、尺寸及非印刷制作标注，保留真实印刷内容；不凭颜色或粗线启发式删除装饰线，不修改原始 `.ai`。结构几何仍需保留用于完整性校验，不能把辅助线隐藏误实现成结构部分被裁掉。不能用六面 PNG 拼接、GLB 截图或单个矩形包围盒冒充原稿展开关系。已存“artwork/预览”产物能否包含完整几何和可靠净版内容须在实施前核实，现有六面读图能力不构成证明。

打印默认：独立下载净版展开 PDF，PDF 页面物理尺寸及内容坐标与源稿一致，保留可能存在的留白，不为适配 A4 自动缩放或裁切；图像预览可缩放，不能改变导出比例。界面显示“原尺寸 1:1 打印”，提示实际大小/100%和合适纸张。无刀线净版不额外印裁切/折叠参考线；须由用户依据盒型结构裁切、折叠和粘接。原六面 PNG 与六面 ZIP 继续单独提供，七个标签不等于七个面。自动多页拼接与商业印前交付未纳入。此打印载体默认不表示真实导出或物理折盒已通过。

产物与旧单：使用独立的净版展开资产及状态，不冒用 `read_*` 六面资源。能复用已有完整净版源件则只补导出；需 Illustrator 时沿现有宿主队列、版本围栏和禁杀阶段，不新建控制链，也不为下载重跑 Blender。净版分离、完整结构、源尺寸无法可靠确认时，说明不能生成可打印展开稿，不能退回带刀线原稿或缺粘口的六面拼图并称成功。实际资产键、原子发布、下载权限和旧单补齐接线在产品实施时与两侧合同同步。

验收增补：同源与同代一致；无刀线但装饰线/文字保留；完整粘口/上下封口（含无印刷色块的空白部分）；PDF 物理尺寸/坐标不缩放且不截断；旧单来源不齐明确失败；六面PNG/ZIP与3D不回退；至少代表性真稿按实际大小打印后，经裁切/折叠/粘接能形成对应盒型，记录实测尺寸和缺口。原六面下载测试或合成示意图不能关闭此项。

本轮仅补交仓库外 `beian-unfolded-preview.html`：默认进入打样单，七标签中首项为2D展开图，独立“下载展开图PDF”和“下载六面ZIP”入口。所画净版是明确标注的合成结构示意，未读取或导出真实 `.ai`，不能拿示意图声称结构准确或可物理折盒。检查记录 `unfolded-prototype-checks.json` 覆盖标签顺序、七项切换、六面PNG保留、打印下载说明、宽度320/390/736/1024/1440下无整页横向溢出及示意展开图比例保持；未跑真实PDF打印、Illustrator、Windows或产品测试。外部旧快照未覆盖本次范围修正，仍不能记作新版外评通过。
