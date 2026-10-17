# 签字与退回

审稿员把疑点/缺失都下完结论后，在页头点「签字」或「退回」。还有待确认时两者都不让提交；有标了「有错」的条目时只能退回（「有 N 条标了有错，请退回」）。点后弹确认框（「签字这份稿？」/「退回这份稿？」），确认后提交；提交失败不关框、可重试；成功后显示「已签字。」/「已退回。」并锁定。

## Sub-features

- `sign-gate` 有待确认时签字/退回禁用并说明原因；有「有错」时签字被拦。
- `sign-confirm` 签字确认框文案、提交体 `{ conclusion: "无改稿项" }`、成功后签字按钮 disabled。
- `sign-retry` 提交失败显示「没提交成功，请重试」，点「重试」成功。
- `return-confirm` 标有错写原因后退回走确认框「确认退回」，有错清单 `aria-label="有错清单"`。
- `zero-doubt` 零疑点时右栏写没发现问题，签字可点。

## How to get to it (user POV)

- `/review/<id>` 页头 `getByRole("button", { name: "签字", exact: true })` / `{ name: "退回", exact: true }`。
- 确认框是 `getByRole("dialog")`，按钮「确认签字」/「确认退回」。

## Driving it with Playwright e2e（合成 API）

Preconditions:

- 在 `apps/web/ui` 下，5173 端口空闲。

- **签字与重试。** `npx playwright test e2e/review-workspace.spec.ts -g "签字确认框文案；提交失败不关框并可重试；签字后锁定" --workers=1 --reporter=line`。确认框文案正确、失败后可重试、`.ant-alert` 出现「已签字。」，最后一次 `/complete` 请求体为 `{ conclusion: "无改稿项" }`。
- **退回。** `npx playwright test e2e/review-workspace.spec.ts -g "标有错写原因后退回走确认框" --workers=1 --reporter=line`。退回走确认框，「确认退回」在待确认未处理时 disabled。
- **零疑点。** `npx playwright test e2e/review-workspace.spec.ts -g "零疑点：右栏写没发现问题，签字可点" --workers=1 --reporter=line`。

## Gotchas

- 签字/退回会写盘并发通知；**真后端上不要对线上或共享数据点签字**。在临时实例上做需要带 hits 的可审核种子（`status: "pending_review"`），目前没有现成场景，也未实跑——若要证明后端落盘，先补场景，并用 `GET /api/tasks/<id>` 的 `status`/`complete_kind` 作第二视图。
- 服务端对已完成单回 400（「当前状态不可签字」）；这条路径会触发锁页，不是报错。
- 合成 fixture 的放行规则与服务端 `/complete` 同口径（还有疑点/缺失未处理 → 400），但它仍是合成，不能当后端证明。
