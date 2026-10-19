# 成片、导出与资产路由合同

本文件保存原 AGENTS 的对应工程合同，仅在涉及本主题时读取。产品行为不构成执行作业、发送消息或操作生产的授权。日期与验收状态是记录时快照，当前结论须绑定本次证据。路径除链接外均相对仓库根。

## 打样成片与背景

打样单白底浅底+内描边；产品灯光和背景灯光分开调（静帧产品层 CSS 滤镜、白底/GLB 背景色、GLB 曝光），不重跑 Blender。下载白底是调过光的合成图。有 `white_a_ground` / `white_b_ground` 的新单走 grounded 成片：canvas 铺 `rgb(228,228,232)` 再 multiply 地面、叠产品，预览和下载同一合成器；布局仍是一屏三列（正面+侧面、反面+侧面、GLB），grounded 框 5:6，不要上 1 下 2；页头藏「下载 PPT」，灯光收到页头「调灯」后面。成片背景三键白底/银底/白桌白墙走 compositor，不排队 Blender；白/银不乘地面；白桌白墙有 `white_*_set` 时画 set+产品（不再 CSS 墙、不再乘旧 ground），缺则 CSS 近似加接触影，不是木桌。`*_set` 不能当产品静帧。GroundedShot 第一屏先读 `white_*_card`（Blender 后最长边 1440），解码成功的 full 原位替换 canvas 源；卡 415/失败回退全图，full 失败保留卡图并提示重新打开此单。`*_card` 不能当产品静帧，也不能当 `*_ground`。地面图坏了就藏原图和下载。`*_ground` 不能当产品静帧。没有地面图的旧单仍是三栏白底、浅底+内描边、页头「下载 PPT」。

成片下载在点击时冻结出图版本、背景选择和产品/背景灯光；灯箱打开时以灯箱正在使用的图层选择背景。已显示布景但布景 full 尚未就绪或失败时提示重试，不放大卡图导出或改用地面背景；当前显示地面近似时继续使用同代 full 产品/地面，不等待未使用的布景。切换版本或离开页面后，已开始的下载继续完成。原图灯箱先保留可用图层，product/ground full 无需等待 set full；set full 失败保留已显示的 set card。

## 重试、补图与进度

打样中和打样失败可重试，用机上已有稿再排，不必重传；先确认旧 worker 已退出；仍运行时遵守 [结构与宿主合同](packaging-structure.md) 的 Illustrator 禁杀阶段，无法安全退出就 409。已出图缺印刷面走 `POST /api/mockups/:id/print-faces`（V2 `render_face_assets`，不跑 pipeline/Blender，status 仍 done；持久入队立即返回 202，页面轮询补面子状态，失败可重试，刷新或离页不取消作业）；不要对 done 打 retry。下载提示走 `mockupHud.ts`（不挡点击）；GLB 全屏走 `mockupFullscreen.ts`。等待圆盘是 `WaitLoader`（对照中 / 对红中 / 打样中，不要英文 Generating）。结构导出阶段 WaitCard / `liveJobLine` 只写「打开稿件 / 盘点图层 / 保存印刷 PDF」等中文阶段，没有 `job_eta_s` 就不要编造 120 秒或 4 分钟。

## 导出与 PPT 规则

- 导出不会悄悄换背景。点下载时，打样单记下当时的背景、产品灯光、背景灯光和画面来源，之后按这一套合成。页面上显示的是白桌白墙布景、而布景高清图还没就绪时，这次不出图，提示稍后重试。不会改用白底或地面图代替。下载开始后切换版本或离开页面，这次下载仍按点击时的设置完成。
- PPT 能出就出，出不了不算失败。打样流水线先用两张白底写 PPT，写不出再试演示文稿运行时。两次都写不出时，流水线在 stderr 打「PPT 跳过」，静帧、PDF 和 GLB 照常交付，整单仍是成功。

## 资产与路由

下载白底只给 `front_right` / `back_left`，不要把 `ai-raster` 或 PPT 质检 PNG 当成白底。`*_ground` 映射 `white_a_ground` / `white_b_ground`，不能当 `white_a` / `white_b`。`*_card` 映射 `white_*_card`，不能当产品静帧或地面。读字只给 `read_front` / `read_back` 等 key，对应 `assets/panel_{face}.png`；不要把印刷面当白底，也不要用 GLB 或 3/4 白底静帧读小字。预览 inline 带 ETag，`private, no-cache`，未改可 304；`?download=1` 才附件且 `private, no-store`，不要把 304 空文件当下载。侧栏版本号只读 `/api/status.version`，紧跟在姓名下面，不另写常量。地址按台分开：`/reviewup` `/reviewup/new` `/review/:id` `/mockup` `/mockup/new` `/mockup/:id` `/compress` `/compress/:id` `/history` `/settings`，后退换台。旧 `/` `/new` `/review` 302 到审稿台新地址。

调试：对外 `job_error` 用短中文。Node 日志写 problem + cause + fix。打开 `DATA_DIR/tasks/{tid}.json`。不要新 FastAPI 路由。

## 成片与导出补充

打样台和打样单主区白底深字（深色主题也是）；GLB 中性环境；每张图右上角下载。有 `white_a_ground` / `white_b_ground` 的新单走 grounded 成片：canvas 铺 `rgb(228,228,232)` 再 multiply 地面、叠产品，预览和下载同一合成器；正面大约 480px 的 5:6 主图；页头藏「下载 PPT」，灯光收到「调灯」后面；地面坏了藏原图和下载。GroundedShot 第一屏先读 `white_*_card`（Blender 后最长边 1440），解码成功的 full 原位替换 canvas 源；卡 415/失败回退全图，full 失败保留卡图并提示重新打开此单。`*_card` 不能当产品静帧，也不能当 `*_ground`。`*_ground` 不能当产品静帧。Blender 先出产品 RGBA，再单独跑地面 pass（EEVEE 阴影 + 接触阴影，地面 albedo 0.91），地面失败不挡产品图；重试先 `unlinkSameGenerationStills`（含地面和核对卡）。没有地面图的旧单仍是三栏白底、浅底+内描边，页头「下载 PPT」（没写成仍显示，点了出「PPT 没写成，白底仍可下」）。成片不提供 PDF 下载入口（独立净版展开见下文）；点下载底部提示不挡操作；GLB 全屏居中；截图时下载钮藏起来；全屏被拒写「全屏打不开」。打样单下面印刷面读字。网页把产品叠到可调白底上，所以产品和背景能分开辨认、分开调光；GLB 本来就只导出盒身、环境灯另算。产品灯光调静帧产品层和 GLB 曝光，背景灯光调白底/地面和 GLB 底色，下载跟当前灯光走。原图是同页灯箱，不是另开未调光 PNG。打样中和打样失败可重试，先确认当前 worker 已退出；仍运行时只按既有安全取消合同处理，不能用重试绕过 Illustrator 禁杀阶段，无法安全退出就 409，不必重传。读字只给 `read_*`，对应 `assets/panel_{face}.png`，走现有 `canvasZoom.ts` 1–6×；白底仍只给 `front_right` / `back_left`，不要用 GLB 或 3/4 白底静帧读小字。详情 `publicMockup` / `fileOf` 才按磁盘补印刷面，列表 `publicMockupSummary` 不扫盘。打样 PPT 先用两张白底写 OOXML，不依赖 Node；写不出才试演示文稿运行时。缺 PPT 不要把整单判失败；内部仍用两张白底合成 PDF（页底先铺白；pymupdf 写不出且还没落盘才用已装 Pillow，不要盖掉已写成的文件，不要新装包）。磁盘上的产品 PNG 要重新打样才会变；页上灯光立刻作用。

### GLB 查看器显示

下载 GLB 始终指向原始盒身资产。白桌白墙在浏览器中保留原始材质、贴图、节点和二进制，仅追加显示用桌面与盒后近墙；不用内部 scene API，不重新排 Blender。白底/银底仍加载原始模型。显示资源换代和离页时撤销 blob URL，迟到请求不能覆盖新代，加载失败明确提示，不能用旧模型冒充当前代。

默认视角为 `35deg 72deg` 三分之四构图；透视查看器不承诺与正交静帧像素一致。初始加载、复位、resize 和全屏等待 `updateFraming()` 后，按原盒身世界边界、实际 FOV 写入显式中心及米制距离，避免桌墙扩大取景。默认距离系数 145%，最大 155%，百分比只参与盒身距离计算。墙桌交线位于盒底附近，墙面仅从正面显示；从墙后观察时背面剔除，包装仍可完整查看，此时墙不显示。背景切换保留用户方位及缩放，复位按钮恢复默认构图。桌墙模式保留全周方位旋转，俯仰限制在桌面以上，避免穿到桌下；白底/银底不加该俯仰限制。极窄 FOV 下距离另有桌面范围内的安全上限。

查看器使用仓库内原创无色偏 `carton-studio-v1.hdr` 和 commerce 色彩映射，曝光为 `0.7 × clampStudioLight`。桌墙模式另加随盒身边界生成的柔和接触影近似，不宣称等同 Blender 物理投影。显示房间使用独立自发光材质，按产品曝光倒数补偿，使背景灯只作用房间、产品灯不连带改变桌墙；原始包装材质与下载字节不变。静帧合成不受本查看器调整影响。该方案经过本地合成验证，真实包装画质与杭州实机仍需人工确认。

## 净版展开与六面下载

仅 `GET /api/mockups/:id` 详情增加 unfolded_print 与 print_faces_zip；列表不带这两个字段。unfolded_print.status 为 unavailable / queued / running / ready / failed，reason 仅有原因时出现；只有 ready 带 file_key=unfolded_print、width_mm、height_mm，单位为源稿毫米 1:1，不缩 A4。close_unconfirmed 只与 running 共存。原因集合为 source_missing、geometry_incomplete、separation_unreliable、host_unavailable、source_changed、close_unconfirmed、export_failed。POST 错误优先显示服务端 message，GET 没有 message 时才用稳定原因兜底。

独立 print_faces_zip：0 面 unavailable、1–5 面 incomplete + faces_incomplete、六面才 ready + file_key=print_faces_zip。净版不能由六面拼接或 GLB 截图代替。

两个文件都沿 `/api/mockups/:id/files/:key`：净版仅 ready 返回 application/pdf，坏 PDF 返回 415「净版展开不是可印刷的 PDF。」；六面不齐返回 404「六面印刷图还不齐」，齐全返回 application/zip、print-faces.zip。净版普通 GET 允许 inline 预览，download=1 才附件；缓存头沿既有预览/下载策略。未 ready 或源稿已变不提供旧净版。

## GLB 贴图 WebP 与 `texture_format`

- 旧管线（`runPackaging` → `finishMockup`）每次新生成的打样 GLB，在登记文件前做一次后处理：用 `@gltf-transform/core` + `@gltf-transform/functions`（`textureCompress`，编码器为已有 `sharp`）把贴图转为 `EXT_texture_webp`，quality 90。实现在 `apps/web/server/src/glbWebp.ts`。
- 转换失败、无贴图、已是 WebP 或结果不比原文件小时，保留原 PNG GLB 原样不动，只写服务日志（`glb webp failed, keep original PNG GLB` / `glb webp skipped`），打样照常成功。成功时先写同目录临时文件（`.<name>.glb.webp-<pid>-<ms>.tmp`），复核 `extensionsUsed`，再把临时文件完整读回、核对结构计数与原文件一致，不一致记 `output_structure_mismatch` 并保留原文件，全部通过才原子改名替换。同一服务进程内压缩串行执行，一次只跑一个 GLB，限制解码内存峰值；旧管线调用不设等锁上限和替换前复查（不传 `lockWaitMs` / `beforeCommit`）。服务启动时清理 `DATA_DIR/mockups` 下被中断压缩遗留、名字完全匹配且超过 10 分钟的临时文件（不跟随符号链接），失败只记日志。
- 不在原位转换旧文件；旧文件只走下面的 WebP 旁路，原件不动。

### 旧 GLB 的 WebP 旁路（0.31.1.19，开关默认关）

- 开关在已提交的 `apps/web/server/src/rolloutFlags.ts`，不读环境变量：`GLB_WEBP_VARIANT = false`（是否对外返回旁路），`GLB_WEBP_BACKFILL_LIMIT = 0`（0 表示不回填）。改值或回滚都是发一个只改这个文件的 PR，经老板批准后合并发版。回填本身不在本版，本版只有旁路的存储和读取。
- 旁路存在打样目录下隐藏的 `.webp-variant/`，原件不改，按内容哈希命名：`<原名>.<旁路 sha256 前 16 位>.webpv`；元数据 `<原名>.webpv.json`（schema `glb-webp-variant/2`）记原件和旁路两边的 sha256，`variant.file` 指向当前文件，只认它指向且校验通过的文件。替换时写新文件名、元数据 tmp 改名原子覆盖，不覆盖旧旁路（Windows 上被打开的文件不能删或覆盖）；元数据只一次性读完即关，更新失败返回 failed、旧元数据不动、照旧服务旧旁路或原件。旧哈希文件尽力删，删不掉（EPERM/EBUSY）跳过，下次写入或启动清理再删，绝不删元数据当前指向的文件。服务启动时清理临时/staging 文件、读不出或原件已不在或指向文件缺失的元数据，以及没有被有效元数据指向的所有旁路。会改 GLB 的 10 个入口都先删旁路，有静态测试锁住。
- 开关关着时（当前线上）：对外接口和 0.31.1.17 一样；启动时只在 `GLB_WEBP_VARIANT` 打开时才扫打样目录清理旁路残留（`cleanupGlbWebpVariantsOnBoot`）。两个地址都返回原件，`?v=` 被忽略，`files[]` 里不出现 `glb_version` / `glb_original_version`。
- 开关打开后：
  - `GET /api/mockups/:id/files/glb` 默认返回校验通过的旁路，校验不过就返回原件；加 `?variant=original` 总是返回原件。`download=1` 仍下载原件。
  - `files[]` 里 `key: "glb"` 的条目（列表和详情都有）多两个字段：`glb_version` 是默认地址实际返回内容的 sha256 前 16 位，`glb_original_version` 是原件的。没有有效旁路时两个值相等。`texture_format` 按默认地址实际返回的内容报。
  - `?v=<16 位十六进制>` 和实际返回内容对得上，缓存头才是 `private, max-age=31536000, immutable`；对不上或不带，都是 `private, no-cache`，仍返回 200 和当前内容。ETag 是 `"sha256-…"`；`If-None-Match` 用弱比较（`W/` 前缀、逗号分隔多值、`*` 均算命中，`apps/web/server/src/httpValidators.ts`），对上返回 304。
  - 未登录 401，任务或文件不存在 404。
- 前端：字段缺失就不加 `?v=`；老设备 WebP 解码失败时改请求 `?variant=original`（老设备兜底分支实现）。
- 托管代际（render generation）：`renderGenerationBridge.render()` 在校验 worker 输出凭证之后、生成 seal proof / `content_fingerprint` 所用文件凭证之前，由 `compressCandidateGlb` 对候选 GLB 做同一转换（`compressGlbTexturesToWebp`，与上条同一流程：复核 `EXT_texture_webp`、完整读回核对结构计数），成功后重新计算 sha256/bytes，因此封存、hash 门与质量证明绑定的都是转换后的字节。worker 的 `artifact_checks.glb` 针对转换前字节。转换跑在 8787 服务进程内，与旧管线共用同一串行锁，不受 worker 子进程的进程/内存限制。时间预算（截止时间取本次出图 binding 与资源生命周期两者中较早者）：转换前估算所需 `required = max(GLB_WEBP_MIN_BUDGET_MS（2 分钟）, estimateGlbWebpMs = 10s + 5s × 向上取整的 MiB 数)`；剩余不足 `required` 直接跳过，记 `skipped: deadline_insufficient`。等锁上限为 `lockWaitMs = 剩余 − required`，超时放弃排队并记 `skipped: lock_wait_timeout`，之后即使排到锁也不再转换。改名替换前由 `beforeCommit` 再查一次：用户已取消或剩余不足 1 分钟（`GLB_WEBP_MIN_BUDGET_MS / 2`）则丢弃临时文件、保留原文件，记 `skipped: deadline_insufficient`。跳过或失败都保留 worker 原 GLB 与原凭证，只记日志（`render-generation <job> glb webp ...`）。`compressCandidateGlb` 结束后只在用户取消时让本次出图失败（`render_generation_cancelled`），自身不判超时；超时仍由其后正常检查点按原截止时间判定。已接受的残余风险：转换一旦开始不能中途中止，若单次转换远慢于估算并越过截止时间，结果会被丢弃，但本次出图仍可能在后续检查点按 `render_generation_timeout` 失败。已封存的历史代不回头转换。
- `GET /api/mockups/:id` 的 `files[]` 和列表摘要 `files[]` 中，仅 `key: "glb"` 的条目带 `texture_format: "webp" | "png"`：GLB JSON `extensionsUsed` 含 `EXT_texture_webp` 为 `"webp"`，否则 `"png"`。按文件路径+大小+mtime 缓存，不在每次请求重解析整个 GLB（只读文件头与 JSON chunk）。读不出合法 GLB 时省略该字段。其他 key 不带此字段。前端据此决定是否先跑 WebP 解码检查。
- 前端加载（对后端 PR-a `aff0608` 定稿合同编码，合入前用测试 mock）：默认 `GET /api/mockups/:id/files/glb` 在开关打开且有校验过的 WebP 版时返回 WebP 版，否则原始；`?variant=original` 永远原始。文件信息 `glb` 条目带 `glb_version`（默认地址内容 sha256 前 16 位）与 `glb_original_version`（原始）；两字段相等表示没有有效 WebP 版；开关关着时两字段都不出现、两个地址都给原始、`v` 被忽略。`?v=` 匹配时 `private, max-age=31536000, immutable`，不匹配或缺省 `private, no-cache`（仍 200 当前内容），ETag `"sha256-…"`，`If-None-Match` 弱比较命中 304（同上）；未登录 401，缺文件 404；`download=1` 仍给原始。前端：有版本字段才给两个地址各带 `?v=`；两版本不同时本机解码不了 WebP 直接拉原始，否则默认地址失败/解码错/model-viewer error 自动改拉原始一次；无字段或相等只拉默认地址（保持原行为）。查看器先显示效果图，空闲时后台拉；本机能解码 WebP 但两地址都失败时框底「3D 没加载出来，请重新打开此单」；本机解码不了 WebP（含 WebP 降级路径）失败时框底「这台设备显示不了 3D，已换成效果图」。实现：`apps/web/ui/src/pages/mockupGlbSource.ts`、`MockupGlbViewer.tsx`、`mockupGlbTexture.ts`。
- 发版：依赖变化走 `release.ps1` 停服前 staged `npm ci`；staged 树和 live 树（存在 `glbWebpProbe.ts` 时）都跑 `tsx apps/web/server/src/glbWebpProbe.ts` 离线转换探针，失败拒绝停 8787。CI `windows-2022` 用 Node 20（与生产一致）真跑 `npm ci` + 同一探针，再用合成的同布局 GLB（`glbWebpMemoryProbe.ts`，无客户数据）记录转换峰值 RSS。
