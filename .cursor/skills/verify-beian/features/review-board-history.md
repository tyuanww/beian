# 审稿板与历史

审稿板 `/reviewup` 把核对单按状态排成卡片，完成单卡片写「已签字 / 已退回 / 已提交」（老记录没有 `complete_kind` 时写「已提交」）。历史 `/history` 按名称、类型、状态、创建人、时间找记录，每行标题是「打开<类型>记录：<名称>」按钮，点开进入对应页面。

## Sub-features

- `board-state` 完成卡片 `.review-card .review-card-summary-state` 按 `complete_kind` 显示。
- `history-open` 历史行按钮 `打开审稿记录：<产品名>` 可见可点。
- `history-search` `getByLabel("搜索历史")` 搜索名称或文件，命中排前。
- `history-refresh` `getByRole("button", { name: "刷新历史" })` 重新拉取。

## How to get to it (user POV)

- 左侧导航进入审稿板或历史；或直接打开 `/reviewup`、`/history`。

## Driving it with Playwright e2e（合成 API）

Preconditions:

- 在 `apps/web/ui` 下，5173 端口空闲。

- **完成态。** `npx playwright test e2e/review-complete-kind.spec.ts -g "审稿列表和历史页对有/无 complete_kind 的完成单都能正常显示" --workers=1 --reporter=line`。四张卡分别显示「已签字 / 已退回 / 已提交 / 已提交」；历史页四个「打开审稿记录：…」按钮可见；无 pageerror。
- **历史文件摘要与搜索。** `npx playwright test e2e/history-files.spec.ts --workers=1 --reporter=line`。

## Driving it with verify-real-backend（真后端）

- **历史接口。** 场景 `api` 加 `{ "path": "/api/history", "save": "api-history.json" }`，`pages` 加 `{ "path": "/history", "screenshot": "history.png", "expect": [{ "selector": "button[aria-label^='打开审稿记录']", "visible": true }] }`。尚未写成场景、未实跑。

## Gotchas

- 历史读的是后端 `history/index.json` 只读索引；索引缺失时**第一次** `GET /api/history` 只重建一段并回 503 `history_index_unavailable`（不回空列表），再请求才是 200。2026-10-17 在 `legacy-page-over` 临时实例上实测：第 1 次 503、第 2/3 次 200，但种子的失败单**没有**出现在 `items`（`total: 0`），原因未查明——写历史场景前先查清楚，别把空列表当通过。
- 历史按查看人过滤：非管理员只看到自己的记录；场景默认管理员。
- 合成 fixture 的历史数据是 `e2e/fixtures.ts` 里拼的，不经过后端索引。
