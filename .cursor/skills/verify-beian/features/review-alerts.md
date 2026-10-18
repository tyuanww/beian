# 审稿页报错与超页提醒

审稿员打开一张失败的核对单时，页面顶部用 Alert 说明原因：超页是产品限制，用黄色 warning「稿件超过 1 页，暂不支持核对，请联系管理员」；认字失败换成「认字出了问题，请联系管理员」；其他失败用红色 error。超页只认后端 `job_error_code: "page_over"`，旧失败单（存盘没有码）由后端读取时按两句旧原文补算。

## Sub-features

- `alert-page-over` 有 `page_over` 码时显示 warning 级超页提醒，没有 error 级 Alert。
- `alert-page-over-legacy` 旧单无 `job_error_code`、`job_error` 为「这一单页数超过可核对页数」或「稿件超过 1 页，暂不支持核对，请联系管理员」时，`GET /api/tasks/<id>` 与 `GET /api/tasks` 都返回 `page_over`，页面同上。
- `alert-no-code` 文案像超页但没有码（且不是那两句旧原文/不是失败单）时不显示超页提醒。
- `alert-ocr-failed` 认字失败显示定稿口径文案（error 级）。
- `alert-reupload` 失败单的 Alert 第二行是「重新上传这一单」。

## How to get to it (user POV)

- 审稿板或历史里点开一张失败单，进入 `/review/<id>`。
- 直接打开深链 `/review/<id>`（未登录会先登录再回到该单）。

## Driving it with verify-real-backend（真后端）

Preconditions:

- 在 `apps/web/ui` 下，Node 24；场景 `legacy-page-over` 存在。
- 一次性模式无需已有实例；分步模式需 `helpers/doctor.sh <out>` 为 `DOCTOR PASS`。

- **旧超页单（一次性）。** 运行 `npm run verify:real-backend -- --scenario legacy-page-over --out "$OUT"`。退出码 0，输出 `[verify] PASS legacy-page-over：API 4 项，页面 2 个`（两单分别覆盖两句旧超页原文：`a1b2c3d4e5f6`「这一单页数超过可核对页数」、`b2c3d4e5f6a1`「稿件超过 1 页，暂不支持核对，请联系管理员」）。
- **接口补算。** 查看 `$OUT/api-task.json` 与 `$OUT/api-task-v1-text.json`。含 `"job_error_code": "page_over"` 与 `"status": "compare_failed"`；种子记录本身没有这个字段（见场景 JSON）。
- **页面状态。** 查看 `$OUT/review-legacy-page-over.png`、`$OUT/review-legacy-page-over-v1-text.png` 与 `summary.json`。顶部是黄色 Alert「稿件超过 1 页，暂不支持核对，请联系管理员」+「重新上传这一单」；`.ant-alert-error` 数量为 0。
- **分步驱动。** `--serve` 启动后运行 `node scripts/verify-real-backend.mjs --scenario legacy-page-over --out "$OUT/drive" --base-url <instance.json 的 base>`，结果同上。

## Driving it with Playwright e2e（合成 API）

- **有码。** `npx playwright test e2e/review-workspace.spec.ts -g "超页：后端回 job_error_code=page_over 时显示黄色提醒" --workers=1 --reporter=line`。1 passed；`.ant-alert` 含超页文案且带 `ant-alert-warning`。
- **无码。** `npx playwright test e2e/review-workspace.spec.ts -g "超页：报错文案像超页但没有 page_over 码时不显示超页提醒" --workers=1 --reporter=line`。1 passed。

## Gotchas

- 旧单补算只认失败单（`job_status: "failed"` 或 `status: "compare_failed"`）且整句相等；改种子时多一个空格之外的字都会不再补算——这是预期，不是 bug。
- 合成 e2e 的 `syntheticApi` 不会补算 `page_over`，它只证明前端按码显示；补算必须用真后端场景证明。
- 非管理员看到的 `job_error` 会被脱敏（去本机路径，必要时整条隐藏）；场景默认用「管理员」登录，换身份时断言要跟着变。
- 页面只有失败图而无页面图时画布区显示「这一页没有图」，这不是失败。出口以顶部失败条为准，空态不再写「返回看板重新上传」。
