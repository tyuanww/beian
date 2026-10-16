# 作业、上传与进度合同

本文件保存原 AGENTS 的对应工程合同，仅在涉及本主题时读取。产品行为不构成执行作业、发送消息或操作生产的授权。日期与验收状态是记录时快照，当前结论须绑定本次证据。路径除链接外均相对仓库根。

对照 / 对红 / 打样共用作业合同。仅涉及相应模块时应用对应条款；产品行为要求不是让代理启动作业或操作生产的命令。确认合同不必启动产品。

0. 需要验证对照/对红 CLI 入口或合同、且本机依赖已具备时，先运行以下只读命令，无需启动产品。仅改文档或无关模块时不运行；用户要求实际启动时仍应完成启动验证：

```bash
cd apps/web/backend && PYTHONPATH=. .venv/bin/python -m app.cli --help
```

禁止：`uvicorn`、把 FastAPI 加回来、把 `save_task` 抄回 CLI。产品入口仍是 `./scripts/dev-start.sh` → Hono `:8787`。

1. CLI 在 `apps/web/backend/app/cli.py`。stderr 打 `STAGE <name>`。stdout 最后一行是结果 JSON（不要 `ocr_text`）。不要 `save_task`。
   打样不是 `app.cli` 子命令；`jobs.ts` 调 `workers/packaging`；HTTP 仍是 `/api/mockups`。packaging stderr 打 `STAGE illustrator_<stage>|render_pdf|blender|export`（打开稿件/盘点图层/保存 PDF/出图/打样/导出）。结构阶段不要写死 120 秒。平面出图 pymupdf 先，macOS `qlmanage` 只在 pymupdf 失败时兜底。

2. 第一次 queued 落盘之后，只有 `apps/web/server/src/jobs.ts` 再写任务文件。`enqueue({ kind, id })`。路由只 save queued 一次，之后这个 tid 归 `jobs.ts`。

3. Hono 动作立即返回。没有 `/api/jobs` 资源。新建审稿/打样先走上传会话：`POST /api/uploads/sessions` 创建或找回会话，`PUT /api/uploads/sessions/:id/files/:field` 按 1 MiB 分片落盘，`POST /api/uploads/sessions/:id/complete` 生成回执；再用回执调用 `/api/tasks/start` 或 `/api/mockups/start`。`POST /api/uploads` 只保留给旧页面兼容。`GET /api/uploads` 列当前登录者的 partial 会话和 ready 回执，`DELETE /api/uploads/:id` 两者都能放弃。新稿上传用两条流式落盘通道，不得退回 `parseBody` / `File.arrayBuffer()` 整包驻留内存；第三份立即 429。审稿总量固定不超过 100 MB，上传会话和回执 30 分钟过期，并限制每人/全局数量和字节数。分片用 SHA-256 与 offset 校验，同一 `client_upload_id` 只恢复本次上传；开始接口按 `owner + source_receipt` 串行并幂等。领取回执必须原子改名为 durable claim，任务 JSON 落盘后才 commit；准备失败 rollback，进程中断后启动恢复按持久化 `source_receipt` 决定恢复回执或完成清理。用户放弃回执时先把 claim 原子改成删除墓碑，重启只能继续删除，不能还原。回执过期的稳定错误码是 `upload_receipt_expired`，UI 不匹配中文文案。UI 上传状态跨 SPA 换台保留；整页刷新可找回服务端会话，重新选择同一文件后从已确认 offset 续传。

4. 修改作业合同的测试：参考 `jobs.test.ts` 的对照块，复用有效覆盖，只为受影响行为补充或调整断言，不要求每次重写全部测试。对应合同必须保持：第二单 queued、GET 无 `job_pid`、没有最后一行 JSON →「对照中断」、对红失败仍可签字。打样结构：`STAGE illustrator_saving_artwork_pdf` 无假 `job_eta_s`；Agent busy 不领新 AI 单。pytest：CLI 不 `save_task`；`--help` 含 `STAGE` / `save_task` / `packaging`。打样出图测 pymupdf（`test_packaging_thumbnail.py`），不要假定有 qlmanage；Blender 后写最长边 1440 的 `*_card.png`。打样 PDF 测铺白和 Pillow 兜底（`test_packaging_dieline.py`）：pymupdf 已落盘则不覆盖，不要让人再装插件。Illustrator 无人值守合同见 `test_packaging_illustrator_structure.py`：saving 禁 Kill、busy 不当 offline；盘点 hide+outline、`restoreUnattendedArtwork` 失败禁 PDF、`eachInventoryPathItem` 展开组。

## 作业入口与等待

出图版本的 Q06.6 A 只在显式临时 runtime 装配固定 `upgradeCandidate` 时接通 upgrade；普通产品默认无 runtime 注册，临时根与平台门仍独立拒绝不合格装配，不能只凭 `productionEnabled=false` 判断安全。HTTP 创建体不接收任何 profile 字段，Python 缺 `upgrade_profile_id` 仍 `upgrade_unwired`；源 RF-02 验证先于绑定结构的候选解析。升级继续复用权限、幂等/CAS、审计、容量、产物质量与失败留图门，合法已有代的 history/activate 独立可用。平台实现允许 darwin/linux、拒绝 win32，本次原生证据只覆盖 Mac。A 开发不依赖 Q06.7；B 生产装配须 Q06.4 与既定八点审计，C 启用须 Q06.7/.8 及明确授权，状态见 [TODOS.md](../../TODOS.md)，参数见 [worker README](../../workers/packaging/README.md)。

UI 等待：`shouldShowWaitCard`（`queued` | `running` | `comparing`；`done`/`failed`/`completed` 不当等待）。离开核对页后，看板 `liveJobLine` 和侧栏 `liveNavPulse` 仍显示阶段。打样台只交稿；点进度/已出图进单独打样单（WaitCard 或成片/三图看形，下面印刷面读字），不要在打样台底下摊开结果。唯一「上刀线」（或单层「刀线」/「刀版」）默认黑盒提交识别，候选里唯一「印刷」可随刀线带上，失败对籽烨结案为打样失败，选层只给 admin；单独「印刷」和工艺板不能当刀线。

## 生成人与排队显示

- 生成人永远是建单人，只认建单时记下的 `created_by`。有 `created_by` 就查出名字显示，查不到或重名时显示「未记录」；老任务没有 `created_by` 的，接口返回 null，生成人也显示「未记录」。不拿最后下结论的人（actor）或别的账号 id 补，也不显示账号 id。单条任务、任务列表、审稿记录和打样列表里的生成人都按这一条处理，审稿台和打样台用同一个规则。历史记录的「生成人」列和筛选用这个值。签字人记在 `completed_by`，不改写生成人。
- 封版存档里的操作者 `actor_label` 记的是触发这次封版的人，只写显示名。查不到显示名，或封版时拿不到触发人，就写 null，版本历史显示「未记录」。不拿生成人或账号 id 补。已经写进去的旧存档不回填、不改写，保留当时的原样，所以本批之前的存档里操作者可能不准。
- 排队中的任务不显示预计时间。`job_status` 是 `queued` 时，等待卡、看板和侧栏只写排队位置：「前面还有 N 单」，前面没有单时写「就快轮到」。运行中才写阶段和预计时间。看板紧凑卡对排队中的单只显示「排队中 · 前面还有 N 单」，不显示百分比；前面没有单时显示「排队中 · 就快轮到」。

## 补印刷面持久队列

`POST /api/mockups/:id/print-faces` 保持既有 create 权限与团队共享范围。首次入队由 jobs 写 `print_faces_request`，立即返回 202；同单在途请求返回既有工作，跨单进入同一打样执行槽串行等待。成片 `status=done`、既有图片和下载保持；公开详情只给 `print_faces_repair.status/error`，不返回 PID、源稿哈希、尝试身份或私有路径。已经完整且成功的请求返回 200，不重复切面。

补面 queued/running 都进入 `queueSnapshot().blender`，发版 drain 在请求响应结束后仍能看见持久工作；损坏记录进入 jobs_unknown。补面与换正面、切代、删除互斥，托管代继续拒绝原位补面。页面轮询该子状态，不把已出图单变成全屏等待。

执行时冻结源文件身份并复制到本次私有目录；Python 只写本次暂存 assets，正常退出并复核源稿/任务身份后才发布 PNG。中断恢复使用新尝试身份，防止旧回调和旧暂存覆盖新工作；只在核实旧 PID 不存在或已确认终止后恢复。PID 归属不明或处在 spawn/持久化间隙时保留 running 与执行围栏，不自动重跑或宣称排干。逐张 PNG 原子替换并非整套文件的断电事务；未确认完成的请求从同一冻结源重做，Windows/断电实证另验。

普通发布异常可能发生在部分 PNG 已替换之后；请求保存为 failed，错误和重试入口不因必需四面已存在而隐藏。重试重新排队切面，排队/执行提示保持到成功；不把部分文件存在当成补面已完成。

## 净版展开与文件压缩

`POST /api/mockups/:id/unfolded-print` 无请求体，沿 create 与管理该单权限；200 复用完成结果，202 返回持久 queued/running，409 使用顶层 message/reason（busy 仅顶层），不创建失败忙请求。发布已有可信 PDF 与原生补导出都计入排队快照/drain；原生任务与打样共用 Illustrator 槽。源稿或代际变化不能发布旧结果。running + close_unconfirmed 保持围栏，重试不得再开第二个 native。启动恢复沿既有归属与关稿证据，不把结果 JSON 当作退出证明。

压缩上传使用 purpose=compression、asset1–asset20，现有分片/回执通道；总量 100MiB。任务创建复用 owner+receipt 幂等，逐文件持久状态，重试使用 expected_revision 和 file_ids，已成功文件不重压。queueSnapshot 独立计入 compression；离页不取消已受理任务。未知 output_bytes 保持 null。

压缩工具须先证明可用的进程容器再领任务：Windows 复用有归属的 Job Object（聚合 commit 上限并采样 RSS），Linux 使用获授权的 cgroup v2；不能用 macOS RLIMIT 或一个 probe 标签冒充整树内存限制。所有取消等待归属子树退出，stdout/stderr、时间、候选/尝试磁盘都有边界。初值、具体执行器及许可记录随 compression 模块维护；Windows RSS/磁盘监控的现场行为仍须单独取证，不由 Mac 单测证明。

## 审稿原生前置

新审稿/对红输入含 Illustrator 私有数据提示时，由 jobs 在 OCR 前准备原生请求；提示仅用于分流，不能作文字可信证明。关闭证据和稿面覆盖检查通过后，原生文字可以成为本次审稿主来源并跳过百度 OCR；覆盖不足或页面含大面积图片时继续既有 OCR 回退。queued 前置不占 OCR 执行槽，与结构/净版按 FIFO 共享 Illustrator 槽。120 秒仅限制未派发的排队，过期用 native_busy 继续 OCR；派发后按原有 1260 秒生命周期，超时保留桥接和围栏，不把杀进程当关闭。

持久 native_text_request 绑定源 hash、source_name、提取器版本及 attempt。私有物理副本独立目录留存；已知执行者结束和同代关闭记录都确认后才可恢复围栏，晚到证据不能替换已经选择的 OCR 回退。running + close_unconfirmed 即使审稿已完成也计入 drain，并阻止删除其被引用副本、再次原生请求；单次 idle 心跳不清围栏。损坏持久记录计 unknown 且阻止新 Illustrator 领单。宿主在执行中被重启（关闭记录永远不会到达）时，唯一出口是先停 8787、管理员确认 Illustrator 无客户稿后运行 `apps/web/server/src/recoverNativeText.ts`：必须给出确切 task 与 attempt id，且记录的执行者 PID 已被证明不存在（无 PID 或身份不明一律拒绝）；写入与已证明关闭相同的 fallback/native_failed，不改 OCR 结果、不删副本、无 HTTP 入口。缓存只在新的审核运行、同源/同提取器版本使用。
