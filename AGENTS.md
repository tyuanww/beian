# AGENTS.md

请用中文回复。`beian` 是供应链备案审核网页。React 界面在 `apps/web/ui`，Hono 控制面在 `apps/web/server`，Python 对照在 `apps/web/backend`，打样只调用 `workers/packaging`。

## 执行与授权

- 按用户要求的结果推进。只读分析、审查或方案交付结论和证据。实施任务在授权范围内改到位并验证。常规可逆选择自行处理，遇到实质业务取舍或权限不足时先完成独立部分。
- 改文件前核对目标差异，保留用户已有修改。按项目合同复用现有实现和验证入口。同一变更涉及的规则与行为一起更新。
- 生产机、`apps/web/backend/data/runtime/` 和生产 tasks 目录的登录、读写或脚本执行均需单独授权，包括只读统计。发送消息及测试消息、发布飞书版本、购买云、变更 DNS 或公网端口、删除重要数据，也需对应授权。修改共享电脑的全局 Git 配置、凭据或令牌权限前先取得同意。
- 按任务选择 Skill。用户点名时读取对应 `SKILL.md`。默认由当前 agent 完成，子 agent 和模型按已授权的流程使用。Skill 的安装、升级、遥测、配置、自动提交和记忆写入沿用各自授权。审计 Skill 时只读其内容。

### 发布与合并

提交、推送、创建 PR、合并、部署和删除分别核对授权。「继续」沿用已授权阶段。合 `main` 需要用户本轮明确说「合 #N」。从 Mac 在 GitHub squash 合入后会触发杭州 Windows 发布。

## 项目边界

- 产品和验收入口是 `:8787`。开发 Vite 用 `:5173` 反代 `/api`。禁止添加第三个产品入口、恢复旧前端或增加 FastAPI/uvicorn。保留现有审核引擎和 3D 流水线。需要 Blender 而缺失时报告明确失败。
- 禁止读取或打印真实密钥，禁止把密钥放进前端或仓库。按文件名暂存。禁止 `git add -A`，禁止暂存环境文件、密钥、运行时数据、稿件、Vite 缓存、`.claude/` 和 `docs/designs/hangzhou-production-cutover.md`。发版暂存时排除暂缓的 `docs/designs/login-and-permissions.md`。
- 公网及 Tunnel 禁止显示名裸登录。真实后端测试用独立临时数据目录，线上入口禁止传入测试稿或测试数据。只按 PID 结束自己启动的进程，禁止按名称批量结束。
- 对照失败或已完成的单禁止签字，干净签字单禁止再对红。对红结果优先使用非空 `hits_v2`，空数组回退第一轮。工艺说明、颜色要求、版本号、更新内容的 pending 不拦签字，其余条件照常判断。见[审稿合同](docs/contracts/review.md)。

## 按任务查阅

只读本次涉及的合同，共享边界读受影响的两侧。代码定位按全局 CodeGraph 约定执行。

| 任务 | 入口 |
|---|---|
| 测试范围、命令、CI、证据 | [TESTING.md](TESTING.md) |
| 当前事项、文档归属 | [TODOS.md](TODOS.md)、[文档治理](docs/README.md) |
| 公共接口、模块和数据 | [架构合同](docs/contracts/architecture.md) |
| 对照、对红、打样入队、上传、等待和持久化 | [作业合同](docs/contracts/jobs.md) |
| 审稿、核对页、签字和人工结论 | [审稿合同](docs/contracts/review.md) |
| 结构、候选、六面 GLB、Illustrator 和 Blender | [结构与宿主合同](docs/contracts/packaging-structure.md) |
| 成片、下载、灯光、补图、缓存和资产路由 | [成片与资产合同](docs/contracts/packaging-presentation.md) |
| 身份、权限、会话、设置、飞书及版本 | [身份与设置合同](docs/contracts/identity-settings.md)、[开发登录排障](docs/howto-dev-start.md) |
| 用户可见布局、样式、文案和交互 | [DESIGN.md](DESIGN.md)、[界面约束](docs/contracts/interface.md)，再读对应模块合同 |
| 发布、杭州运行时 | [杭州发布合同](docs/contracts/release.md)、[Windows README](scripts/windows/README.md) |

## 验证与维护

- 按 [TESTING.md](TESTING.md) 验证。纯文档检查差异、链接和一致性。代码跑受影响用例。发版准备或创建 PR 跑完整 L0、UI build、`test:quality`、`quality` 和适用的独立评审，并核对最终 PR HEAD 的 CI。复用证据时核对输入和环境。共享构建或状态的命令按依赖顺序运行，保留各步退出码。
- 报告实际跑过的检查。L0 分列服务端、UI、pytest、E2E 的通过、失败和跳过，写明跳过项、仅跑的文件及未跑的组。PR 如调整 L0、文案 lint 或质量基线，在描述中单列并逐项评审。
- 报已上线前，核对同一合并 SHA 的杭州发布与公网版本。静态检查、本地测试、发版 L1、Blender 质量门杭州实跑、真实稿 L2 和业务 UAT 各用本阶段证据。用 [TODOS.md](TODOS.md) 维护待办和未验项。
- 签字或退回的界面变更，同时断言受限单没有按钮、正常单有按钮，并验证服务端能独立拦截。
- 纠正反复出现的问题时，先排除产生错误的路径。用类型或运行时边界约束输入，用 lint 检查静态禁用项，用测试核对可观察行为。用历史失败样本证明新增检查能拦。重复的核验步骤优先复用仓内命令。常驻规则保留本项目需要判断的约定和入口。
