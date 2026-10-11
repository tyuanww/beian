# 版本、身份与设置合同

本文件保存原 AGENTS 的对应工程合同，仅在涉及本主题时读取。产品行为不构成执行作业、发送消息或操作生产的授权。日期与验收状态是记录时快照，当前结论须绑定本次证据。路径除链接外均相对仓库根。

升 VERSION 时：`VERSION` 文件和 `apps/web/server/src/index.ts` 里的 `VERSION` 常量必须同号。`package.json` 只写三位（npm 不认第四位）：MICRO（`0.12.8.0` → `0.12.8.1`）三位不动；PATCH/MINOR/MAJOR 才改三位。4 位号，记录时版本线为 `0.21.x.0`；实际基线读当前 `VERSION`，不得据此降版。用户点名大版本才跳 MINOR。开放 PR 的 VERSION 若落后于 `main`，不合；先 `/ship` 重占号。

杭州机箱管理员必须在生产数据目录 `users.json` 中用真实飞书 `open_id` 显式绑定 `role: "admin"`，才能扫描 Blender / Illustrator（含 PATH）。姓名、花名和显示名只展示，绝不参与提权；同企业首次登录一律是 `reviewer`。删除账号、设 `disabled: true` 或调整角色后，已有飞书会话在下一次请求立即撤销或同步，不要求重新登录；公网模式还必须撤销并落盘清除旧显示名会话。退出直接删 token，不得因账号目录暂时不可读而保留。伸美其他人默认审稿员：能进审稿台，不能扫本机 exe。2026-08-24 当周曾决定不做品牌登录闪屏、申请权限工单（office-hours D1=A）；未有新决定前不主动扩展，相关新请求出现时再核对范围。

飞书推送不必装 lark-cli。点「发一条测试」用已填的飞书应用发给**当前登录**；成功才打开 `FEISHU_ENABLED` 并在空时写入 `FEISHU_OPEN_ID`。`lark_send` 走 `POST /api/settings/probe`，权限见下文 0.31.1.14 一节。开工板绿 ≠ 籽烨已收到。「发一条测试」只发给点按钮的当前登录管理员，不能代发给别人；`FEISHU_OPEN_ID` 为空时，第一次测试成功会把接收人写成这位管理员，所以要先填好接收人再测。真实通知（签字完成、对照/打样完成或失败、Illustrator 看门狗告警）都不指定收件人，统一发给 `FEISHU_OPEN_ID` 这一个人，且只在 `FEISHU_ENABLED` 打开时发送。要确认籽烨作为审稿接收人能收到：管理员核对 `FEISHU_OPEN_ID` 填的是她，再由她确认收到下一条真实通知。不要把开关 / open_id / bot 当主路径让人手填。探测 id `lark_send` 的 pending/结果必须画在行 `lark`，否则按钮看起来没反应。

MiniMax 未开语义复核是「未用」，不是「可用」；探测是 `GET /v1/models`，不是对话也不是余额。百度 OCR 绿 = 对照同款识别接口通了，不是静默授权。已通的密钥默认折叠，点开才改。

开工板是线性进度 + 7 行清单，不要画成圆环仪表，不要用「通 / 不通」当状态字。界面单测只测纯函数，不引入 RTL。

## 设置接口按角色裁剪（0.31.1.14）

实现：`apps/web/server/src/settings.ts` 的 `publicView({ admin })`、`trimFieldForNonAdmin`、`nonAdminHealth`；路由在 `apps/web/server/src/index.ts`。未登录一律 401（`need()`），角色取自当前会话；会话每次查找都按账号目录重读角色（`apps/web/server/src/auth.ts` 中 `account.role !== s.role` 时同步并落盘），管理员被降级后下一次请求即按新角色裁剪或 403。

- `GET /api/settings`：管理员返回不变。非管理员（reviewer / viewer）每个字段保留元数据 `key`、`label`、`kind`、`help`、`restart`、`adminOnly` 和 `set`；除 `kind: "toggle"`（`WB_PUBLIC`、`WB_DEV_DISPLAY_LOGIN`、`FEISHU_ENABLED`、`MINIMAX_ENABLED`）与 `WB_MAX_UPLOAD_MB` 外，`value`、`last4` 两个键整体省略，不返回空串或 null。`derived` 只剩 `tenant_key_filled`（去掉 `redirect_uri`、`python`）；`health.mockup.detail` 在已配置时改为「已配置 Blender」，不含路径，其余 `health` 项原样。队列等其余顶层字段不变。
- `POST /api/settings/probe`（含飞书「发一条测试」`lark_send`）、`GET /api/settings/billing`、`POST /api/settings/billing/refresh`：非管理员 403。`POST /api/settings` 原本即仅管理员，返回的视图按管理员口径。
- 已接受的低风险：非管理员仍能从 `set` 看出哪些密钥/字段已填，看不到值和末四位。
- 有意的行为变化：reviewer 不能再自己点飞书「发一条测试」，只能由管理员测。
- 任务报错按角色脱敏（`apps/web/server/src/pathRedact.ts` 的 `redactLocalPaths`）：
  - 规则：先把整条报错里的 `%5C` / `%2F`（大小写不限）还原成 `\` / `/`；还原后超过 8000 字符只取前 8000 字符处理，其余丢弃不输出，并在末尾追加「（后面省略）」，没截断就不加；截断处的半截路径照常脱敏（如 `C:\Users\bo`、`\\nas\sh` → `本机路径`）。`http://`、`https://` 等网址整段原样保留（含端口、IPv6、查询串、`#` 片段，紧贴中文也一样），到空白、引号、尖括号或非 ASCII 字符为止；`file://` 不算网址，去掉前缀后按路径脱敏。其余文本：① 替换已知本机路径（`DATA_DIR`、`PYTHON`、`pythonBin()`、`blenderBin()`、`illustratorBin()`，按长度从长到短，可含空格）；末段像文件名（带 1–8 位扩展名）换成文件名，否则换成「本机路径」，紧跟其后的子路径只留文件名。② 其余路径去掉本机目录、只保留文件名（无文件名的目录写成「本机路径」）。覆盖：Windows 盘符路径 `X:\` / `X:/`（含小写盘符，盘符前不能紧贴 ASCII 字母数字，所以 `abc:\x\y.pdf` → `abc:y.pdf`；目录名可含空格，只要空格后的词在新路径起点、空白或标点之前还有分隔符，如 `C:\Program Files\客户 新品\a.ai 打不开` → `a.ai 打不开`）、UNC `\\server\share\...`（含 `\\?\`，空格规则同 Windows）、无盘符的反斜杠路径（如 `\Users\bob\a.pdf` → `a.pdf`，至少一级目录且末段带扩展名才算）、至少含一级目录的 Unix 绝对路径（`/Users/...`、`/home/...`、`/var/folders/...` 等，前一个字符不是 ASCII 字母数字或 `. _ - ~ / \`，所以紧贴中文也算，相对路径如 `docs/x.md` 不动；遇空格即止）、`~/...` 与 `~用户名/...`，以及可含空格的已配置数据目录、Python / Blender / Illustrator 路径。文件名在空白、引号、括号和中英文标点处结束；扩展名后紧跟中文时到扩展名为止；堆栈里的 `x.ts:12:5` 保留行列号；替换结果与紧贴的中文之间补一个空格（如 `打开/tmp/abc/a.pdf失败` → `打开 a.pdf 失败`）。实现为单趟线性扫描（无回溯正则），5000+ 字符对抗输入各 <50ms。例：`C:\supply\data\x\a.pdf` → `a.pdf`，`目录 /a/b 不可写，见 docs/x.md` → `目录 本机路径 不可写，见 docs/x.md`。
  - 已知缺口：Unix 目录名含空格时空格后的片段会留下（如 `/Users/bob/My Docs/a.pdf` → `本机路径 Docs/a.pdf`）；双重编码（`%255C`、`%252F`）只解一层，不当分隔符；全角斜杠 `／`、`＼` 不当分隔符。已知副作用：`%2F` / `%5C` 整条报错一起解码，非路径文字也会变（如 `进度 50%2F100` → `进度 50/100`，网址里的 `%2F` 同样被解开）。
  - 任务详情（各路由经 `publicTask(task, viewerFromSession(s))`，`apps/web/server/src/jobs.ts`）与任务列表（`apps/web/server/src/tasks.ts` 的 `shownError`）里的 `error` / `job_error`：非管理员返回脱敏文本，管理员（`viewerFromSession` 的 `admin: session.role === "admin"`）看原文；`publicTask` 未传 viewer 时按非管理员处理。
  - 飞书失败通知（对照任务 `fireTaskNotify`、打样 `fireMockupNotify`）里的报错一律脱敏，与收件人角色无关。打样详情/列表的报错仍走原有 `publicMockupError`，不在本项范围。
  - 未纳入、未审计（可能仍带出本机路径）：`apps/web/server/src/index.ts` 全局错误处理对 4xx 原样返回 `err.message` 作 `detail`；Illustrator 看门狗飞书告警（`notifyIllustratorWatchdog`）；打样 `print_faces_repair.error`；`apps/web/backend` worker 输出与其他 HTTP `detail`。跟进见 TODOS F10。
