# beian 验证地图

这里是 beian 审稿工作台面向用户行为的验证清单。驱动前先读本页，再按对应功能文件执行。两套驱动：**真后端场景**（`npm run verify:real-backend`，见 `../SKILL.md`）和**合成 API e2e**（`apps/web/ui/e2e`，Playwright）。

## 基线前提

- Node 24，仓库根已 `npm ci`；Playwright chromium 已安装。
- 真后端：只用脚本建的临时 `WB_DATA_DIR`（`/tmp/beian-verify-*`），端口由脚本挑空闲端口；登录身份是后端首启自动创建的「管理员」（role=admin）。
- 合成 e2e：Playwright 自起 Vite `127.0.0.1:5173`，全部 `/api` 由 `e2e/fixtures.ts` 的 `syntheticApi` 应答，不连任何后端。
- 驱动 `--serve` 实例前 `helpers/doctor.sh <out>` 必须 `DOCTOR PASS`。不驱动不是本次运行起的实例；不碰 `runtime/`、`apps/web/backend/data`、杭州生产机和 www.jianghua.site。

## 驱动约定

- 路由：审稿页 `/review/<12 位任务 id>`，审稿板 `/reviewup`，历史 `/history`。
- 句柄优先级：`data-testid`（如 `review-dock`、`review-undo-toast`、`review-posn`）> ARIA 角色 + 名字（`getByRole("button", { name: "签字", exact: true })`）> 稳定类名（`.review-lock`、`.ant-alert-warning`）。不用坐标。
- 文案以 `apps/web/ui/src/copy/labels.ts` 为准；断言文案前先查那里。
- 每个功能文件的命令都按字面执行。

## 证据与跳过的报告方式

- 真后端：`summary.json` + 接口 JSON + 截图；同时证明接口字段和页面状态。
- e2e：命令、通过数、失败时的 `test-results/` trace 和截图。
- 每份证据注明功能 ID 与入口。走不通的入口照实报告「尝试了什么、缺什么前提」，不要换一条路冒充已验证；不为了通过而削弱断言。

## 功能文件约定

每个文件一个 H1 + 一段用户可见行为，然后按顺序四个 H2：`Sub-features`、`How to get to it (user POV)`、`Driving it with <harness>`、`Gotchas`。

## Features

- [审稿页报错与超页提醒](./review-alerts.md)：超页黄色提醒（含旧单补算 `page_over`）、认字失败、其他失败。**真后端场景 `legacy-page-over` 已实跑。**
- [锁页与撤销提示](./review-lock-undo.md)：别人已签/已退回时只读锁页；下结论后的撤销提示，锁页时立即收起。
- [签字与退回](./review-sign-return.md)：签字/退回的放行规则、确认框、提交失败重试、签后锁定。
- [审稿板与历史](./review-board-history.md)：`/reviewup` 卡片完成态、`/history` 搜索与打开记录。
