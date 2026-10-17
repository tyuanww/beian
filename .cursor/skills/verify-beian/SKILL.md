---
name: verify-beian
description: "驱动 beian 备案审稿工作台（www.jianghua.site 的本地副本）来证明行为：审稿 Web UI（/review、/reviewup、/history）+ 任务 API（/api/tasks），跑在本机真后端（Hono + 构建后的 UI）和写入合成任务记录的临时数据目录上；第二套是 Playwright e2e（拦截全部 /api 的合成数据）。给 PR 证明 UI/API 行为时用，不碰生产、不碰线上或 runtime 数据。"
---

# verify-beian

beian 是包装备案审稿工作台：Excel 标准 vs 稿件 PDF 的核对结果在审稿页逐条下结论，再签字或退回。用户摸到的是 Web UI，数据走 `/api/*`。本技能给出两套驱动方式：

1. **真后端（主）**：`apps/web/ui/scripts/verify-real-backend.mjs`（`npm run verify:real-backend`）。临时 `WB_DATA_DIR` + 场景 JSON 写入的任务记录 + 空闲端口上的真 Hono（serve `apps/web/ui/dist`）+ 本机显示名登录 + 无头 Chromium。证明「后端读出来 + 页面显示」这一整条。
2. **合成 API e2e（辅）**：`apps/web/ui/e2e/*.spec.ts`（Playwright + `e2e/fixtures.ts` 的 `syntheticApi`，拦截全部 `/api`，起 Vite dev server 5173）。证明交互流程（下结论、撤销、签字/退回、别人先签导致锁页），这些需要写操作或时序，在真后端上没有现成种子。

## 铁律

- **数据**：只用脚本 `mkdtemp` 出来的临时目录（`/tmp/beian-verify-*`）。**永不**把 `WB_DATA_DIR`、`--out` 指向 `runtime/` 或 `apps/web/backend/data`（脚本会拒绝并退出 2）。
- **机器**：只在本机/沙箱跑。**永不**登录或操作杭州生产机，不用发版工作流做验证。
- **线上**：**永不**向 www.jianghua.site 上传测试稿、建单或登录；`--base-url` 只接受 `http://127.0.0.1` / `http://localhost`。
- **进程**：只结束自己起的进程，**按 PID**（或自己起的进程组 PID）。不用 `pkill` / `killall` / 按名字结束；Playwright 的 5173 dev server 由 Playwright 自己收。
- **证据**：证据目录（`--out`）在清理后必须还在；清理只删实例和临时数据目录。
- 环境：Node 24（`unset NPM_CONFIG_PREFIX; . ~/.nvm/nvm.sh; nvm use 24`），仓库根 `npm ci`；Linux 上若 Vite 报缺 `@rollup/rollup-linux-x64-gnu`，按 `.github/workflows/e2e.yml` 的 “Repair npm optional Rollup native” 一步补装（`--no-save`，不改锁文件）。Playwright 浏览器：`cd apps/web/ui && npx playwright install chromium`。

## Launch

一次性（最常用，起→驱动→证据→清理全在一条命令里）：

```bash
cd apps/web/ui
npm run verify:real-backend -- --scenario legacy-page-over --out "$OUT"      # 默认先 npm run build；--no-build 复用 dist/
```

就绪判据：脚本轮询 `GET /api/auth/me` 到 200 才开始驱动；`$OUT/server.log` 首行形如 `beian-server 0.31.1.26 http://127.0.0.1:<port>`。结束时打印 `[verify] PASS|FAIL ...`，退出码 0 / 1（断言失败）/ 2（环境或启动问题）。

分步（要先体检、再手动或多次驱动时）：

```bash
cd apps/web/ui
npm run verify:real-backend -- --scenario legacy-page-over --out "$OUT" --serve > "$OUT.serve.log" 2>&1 &
# 等到 serve 日志出现：[verify] READY http://127.0.0.1:<port>（常驻；结束：kill -TERM <pid>）
```

`--serve` 从空目录开始：建临时数据目录、写场景 `tasks`、起后端、等健康后写 `$OUT/instance.json`（`pid` 常驻脚本、`server_pid` 后端进程组、`base`、`data_dir`、`version`）。用户「管理员」由后端首次启动自动创建（`users.json`，role=admin），不需要另外 seed。

## Doctor

任何异常先跑（只针对 `--serve` 实例）：

```bash
.cursor/skills/verify-beian/helpers/doctor.sh "$OUT"
```

逐项 PASS/FAIL：常驻脚本与后端进程在；端口由 `server_pid` 进程组监听；`/api/health` `ok=true` 且版本等于仓库 `VERSION`；数据目录是临时目录、且后端进程的 `WB_DATA_DIR` 就是它；本机显示名登录「管理员」得到 `role=admin`。最后一行 `DOCTOR PASS` 才驱动。一次性模式不需要 doctor（脚本内部已等健康，`summary.json` 记录 `server_exited` / `data_dir_removed`）。

## Drive

真后端，按场景驱动（对 `--serve` 实例，可反复跑、可换场景，但场景的 `tasks` 只在启动时写入）：

```bash
cd apps/web/ui
node scripts/verify-real-backend.mjs --scenario legacy-page-over --out "$OUT/drive" --base-url "$(node -p 'require(process.argv[1]).base' "$OUT/instance.json")"
```

场景 JSON（`apps/web/ui/scripts/verify-scenarios/<name>.json`，`--scenario <name>` 或传 JSON 路径）：

```json
{
  "name": "legacy-page-over",
  "login": "管理员",
  "tasks": [ { "id": "a1b2c3d4e5f6", "status": "compare_failed", "job_status": "failed", "job_error": "这一单页数超过可核对页数", "...": "原样写入 <data>/tasks/<id>.json" } ],
  "api":   [ { "path": "/api/tasks/a1b2c3d4e5f6", "save": "api-task.json", "expect": { "job_error_code": "page_over" } },
             { "path": "/api/tasks", "save": "api-tasks.json", "pick": { "id": "a1b2c3d4e5f6" }, "expect": { "job_error_code": "page_over" } } ],
  "pages": [ { "path": "/review/a1b2c3d4e5f6", "screenshot": "review.png",
               "expect": [ { "selector": ".ant-alert-warning", "visible": true, "hasText": "稿件超过 1 页" },
                           { "selector": ".ant-alert-error", "count": 0 } ] } ]
}
```

- `tasks[].id` 必须是 12 位小写十六进制（后端 `isTid`）。记录按旧数据原样写，**不要**替后端补字段（例如旧单就不写 `job_error_code`）。
- `api[].expect`：键是点路径（`a.b.c`），值按 JSON 全等比较；`pick` 从数组（或对象里第一个数组字段）里挑出全部键相等的那一条。
- `pages[].expect`：`visible: true`（可带 `hasText`，等最多 `timeout` 毫秒，默认 10000）和/或 `count: N`（即时计数）。截图为整页。
- 新增场景：复制 `legacy-page-over.json` 改名，写最小的种子记录 + 要证明的接口字段 + 页面选择器；先在旧代码上让它失败一次（证明断言能抓到问题），再在修复后通过。选择器从 `features/*.md` 里拿，别用坐标。

合成 API e2e（交互流程）：

```bash
cd apps/web/ui
npx tsc -p tsconfig.e2e.json --noEmit
npx playwright test e2e/review-workspace.spec.ts -g "锁页后收起撤销提示" --workers=1 --reporter=line   # 单条
npx playwright test --workers=1 --reporter=line                                                       # 全量（约 5 分钟）
```

Playwright 会自己起 `vite --host 127.0.0.1 --port 5173`（`reuseExistingServer: false`，5173 被占会直接失败——那是别人的进程，不要结束它，换时间或换机器）。新用例用 `test` / `syntheticApi` / `reviewTask()` / `completedTask()`（`e2e/fixtures.ts`），`syntheticApi.otherCompletesNext = { by, kind }` 模拟「别人先签/先退」，`syntheticApi.calls` 核对请求。功能清单与选择器见 [features/README.md](features/README.md)。

## Evidence

- 真后端每次驱动的 `--out` 目录：`summary.json`（场景、base、每个接口/页面的 ok 与失败原因、`server_exited`、`data_dir_removed`）、`server.log`、`build.log`、场景 `save` 的接口 JSON、截图；`--serve` 另有 `instance.json`（停止后补 `stopped_at`、`server_exited`、`data_dir_removed`）。
- e2e：`apps/web/ui/test-results/`（失败时 trace / 截图 / 视频）、`playwright-report/`；要留证就复制到证据目录，这两个目录下次运行会被覆盖。
- 证明标准：走真实用户路径（页面路由、按钮、真实 API），不调内部 setter、不加测试专用接口；同时留「动作」和「结果状态」（接口 JSON + 页面截图/选择器断言），不只最后一屏；断言要先在旧行为上失败过一次。合成 e2e 的 mock 只在 `/api` 边界，它证明前端行为，不证明后端；后端读取用真后端场景证明。截图不等于真实稿、L2 或线上验收——报告里照实写。

## Cleanup

- 一次性模式：脚本自己在结束（含 Ctrl-C / SIGTERM）时按 PID 结束后端进程组并删临时数据目录；`--keep-data` 保留数据目录（需要时手动 `rm -rf` 那个 `/tmp/beian-verify-*`）。
- `--serve` 模式：

```bash
.cursor/skills/verify-beian/helpers/cleanup.sh "$OUT"
```

  它向 `instance.json` 的 `pid` 发 SIGTERM，等常驻脚本清理；兜底只按记录里的 PID / 进程组 PID 强杀；然后核对进程组已退出、端口已释放、临时目录已删，并列出仍然保留的证据目录。
- 失败的尝试之后也跑清理，别留进程和端口。不要删 `--out`。

## Helpers

| 位置 | 用法 | 作用 |
|---|---|---|
| `apps/web/ui/scripts/verify-real-backend.mjs` | `npm run verify:real-backend -- --scenario <name|path> --out <dir> [--no-build] [--keep-data] [--serve \| --base-url http://127.0.0.1:<port>]`（在 `apps/web/ui`） | 起实例 / 驱动场景 / 证据 / 清理 |
| `apps/web/ui/scripts/verify-scenarios/*.json` | `--scenario legacy-page-over` | 场景：种子 + 接口 + 页面断言 |
| `.cursor/skills/verify-beian/helpers/doctor.sh` | `helpers/doctor.sh <out>` | `--serve` 实例只读体检（另在临时实例上登录一次） |
| `.cursor/skills/verify-beian/helpers/cleanup.sh` | `helpers/cleanup.sh <out>` | 按 PID 结束 `--serve` 实例并核对清理，保留证据 |
| `apps/web/ui/e2e/fixtures.ts` | `import { expect, reviewTask, completedTask, test } from "./fixtures"` | 合成 API e2e 的数据与拦截 |

地图维护：功能或选择器变了就更新 `features/`，可用 `/maintain-verification-skill`。
