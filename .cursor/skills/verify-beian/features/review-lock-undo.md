# 锁页与撤销提示

一张单被别人签字或退回后，审稿页顶部出现锁页横幅「🔒 这一单已被<谁>签字」（或「…退回，等新稿」），第二行「只能查看，不能再改」，签字/退回按钮禁用。审稿员下结论后底部出现撤销提示「已标为<结论>，撤销」（5 秒后自动消失）；如果这时页面变成锁页，撤销提示在锁页那次渲染里就消失，不再可点。

## Sub-features

- `lock-on-open` 打开已被别人完成的单直接只读锁页。
- `lock-after-400` 下结论或提交时服务端回 400（别人先完成），重读后锁页，不报「没存上」。
- `undo-toast` 下结论后出现撤销提示，点「撤销」改回原结论并回到该条。
- `undo-gone-on-lock` 锁页出现的那一刻撤销提示已不在 DOM 中。

## How to get to it (user POV)

- 打开 `/review/<id>`，在右栏 `review-dock` 里点某条的「有错」或「一致」。
- 打开一张 `status: "completed"`、`completed_by` 不是自己的单。

## Driving it with Playwright e2e（合成 API）

Preconditions:

- 在 `apps/web/ui` 下，5173 端口空闲；已 `npx tsc -p tsconfig.e2e.json --noEmit`。

- **打开即锁。** `npx playwright test e2e/review-workspace.spec.ts -g "已被别人签字：用 completed_by 锁定只读" --workers=1 --reporter=line`。可见「🔒 这一单已被天元（魏炜）签字」，`签字`、`退回` 按钮 disabled。
- **下结论时被锁。** `npx playwright test e2e/review-workspace.spec.ts -g "下结论/撤销时任务已被别人完成" --workers=1 --reporter=line`。重读后 `.review-lock` 可见。
- **撤销。** `npx playwright test e2e/review-workspace.spec.ts -g "撤销把结论改回原来那个并回到该条" --workers=1 --reporter=line`。`getByTestId("review-undo-toast")` 内 `getByRole("button", { name: "撤销" })` 可点，结论回滚。
- **锁页即收起。** `npx playwright test e2e/review-workspace.spec.ts -g "锁页后收起撤销提示" --repeat-each=20 --workers=1 --reporter=line`。20 passed；用例在页面里记录 `.review-lock` 首次出现时 `[data-testid=review-undo-toast]` 是否存在，必须为 false。

## Driving it with verify-real-backend（真后端，仅打开即锁）

- **打开即锁。** 新建场景：种子任务 `status: "completed"`、`complete_kind: "signed"`、`completed_by: "天元"`；`pages[].expect` 写 `{ "selector": ".review-lock", "visible": true, "hasText": "这一单已被天元签字" }`。本场景尚未提交、未实跑。

## Gotchas

- 「别人」按显示名比较：`completed_by` 等于当前登录显示名时**不**锁（自己签的单）。真后端用「管理员」登录，种子的 `completed_by` 不能写「管理员」。
- 撤销提示 5 秒自动消失、antd 退出动画约 0.3 秒；断言「消失」不要用短超时去赛跑，用「锁页出现那一刻」的 DOM 观察。
- 鼠标悬停在撤销提示上会暂停 5 秒计时。
- 真后端没有「别人在我操作中途签字」的种子方式（需要并发写）；这条只在合成 e2e 里证明。
