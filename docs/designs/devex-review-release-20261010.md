# 开发者体验评审：发版流程（merge → hangzhou-release → health）

日期：2026-10-10 · 模式：**DX TRIAGE**（只看会挡住发版的关键缺口） · 适用：`main` = `c67d1a9` / `0.31.1.1` · 证据层级：基于当天三次真实发版与迁移过程，未做新的生产操作。

本评审把“发版流程”当作产品，使用者是写代码的人和 AI。结论只是建议；要做的事已写入 [TODOS.md](../../TODOS.md)（B03、F06–F08），以 TODOS 为准。

## 1. 使用者画像

| 画像 | 目标 | 能做 / 不能做 | 最在意 |
|---|---|---|---|
| 仓库所有者 | 合并后看到新版本在 jianghua.site 上线 | 授权合并、改仓库设置；不想守在杭州机前 | 一眼知道“上线了没有、没上为什么、下一步做什么” |
| 开发 AI（Codex / Grok，在 Mac） | 出 PR、过 CI、按授权合并并报告发版 L1 | 不能 SSH 杭州、不能本地跑 `release.ps1`、不能重启 8787 | 失败信息可在 Actions 日志里读到，不需要人肉转述 |
| 杭州运维 AI | runner 掉线时恢复同一 runner，在途作业结束后重跑同一 run | 不改产品代码、不 pull、不 reset | 明确“允许的唯一动作”，不被诱导去手工升级 |

## 2. 今天的旅程（共感叙述）

07:19 合入 0.31.0.0（PR #1），run 38034011611 在停服前拒绝：“npm 依赖图变化，没有离线快照”。规则写在 README 里，但没有任何路径能满足它——开发者知道“为什么拒”，却不知道“怎样才能过”。修复需要一整个设计 + 实现 PR（#2，0.31.1.0）。

09:56 合入 #2，run 38043142770 约 1 分钟后又在停服前拒绝：stage 内没有 `apps/web/ui/dist`，Hono 入口导入失败。windows-2022 合成测试全绿，但它没有走真实的“依赖变化 + 全部探针按序”的路径。第三个 PR（#3）补上探针顺序、stderr 处理和端到端彩排。

10:51 合入 #3，run 38046344478 三分钟成功，health = 0.31.1.1。

同日还发生仓库迁移：原仓账号被封；新仓 Actions 默认未启用、runner 以 `NETWORK SERVICE` 注册，需人工逐项发现并修正；新仓 main 没有保护。

好的一面：三次失败都在**停服前**、安全、带中文原因；生产从未中断。安全模型是可信的，卡点在“可达性”和“预演”。

## 3. 评分（0–10，TRIAGE 只给关键维度）

| # | 维度 | 分数 | 10 分应是什么样 | 现状差距 |
|---|---|---|---|---|
| 1 | 失败信息与下一步（Fight uncertainty） | 6 | 每个拒绝都写清“问题 + 原因 + 修复方式 + 文档链接”，并出现在 job summary | 原因清楚，但多数只说“拒绝停 8787”，不给修复路径；要翻原始日志 |
| 2 | 发版前预演（Pit of success） | 5 → 7 | 合并前就能在 CI 里复现生产会走的完整路径 | #3 后 windows-2022 已有 staging 彩排；停服后（换位、UI 构建、Agent、冒烟）仍只有合成合同 |
| 3 | 门禁可信度（Credible） | 3 | main 受保护，必需检查绑定，直推不可能 | 新仓 main 无保护；任何直推即触发生产发版 |
| 4 | 环境/迁移可复原性 | 4 | runner 注册、服务账号、Actions 开关有脚本化检查和清单 | 全靠记忆：Actions 未启用、`NETWORK SERVICE` 都是撞上才发现；本指南今天才补 |
| 5 | 发版结果可见性（Findable） | 6 | 一个地方看到 SHA→run→health 三连，自动比对 VERSION | 需手动看 Actions + curl health；health 版本还是 `index.ts` 手写常量 |
| 6 | 依赖变更的体验 | 7 | 改依赖和改代码一样“合并即发” | 0.31.1.x 后 npm 依赖已可自动交接；Python 仍拒绝；Linux/Windows Rollup 原生包靠临时补丁 |
| 7 | 预发环境 | 3 | 有与生产同构、可公开验收的 staging，并明确标示能力差异 | WSL 副本存在但无主机名、无登录要求说明，health 误报 AppleScript |

TTHW（从“合并”到“看到 health 新版本”）：成功路径约 3 分钟（Champion/Competitive）；但今天首次依赖变化的真实耗时约 3.5 小时、3 个 PR（Red Flag）。

## 4. 前 5 项发现与修复（按优先级）

1. **[P1] main 无分支保护（门禁可信度 3/10）**——合并 = 生产发布，但现在直推也会发布。修复：按旧仓 15 项重建保护，必需 `quality` 与 `windows-powershell-contract`（TODOS B03）。成本：用户授权后 10 分钟。
2. **[P1] 迁移/runner 前提没有自检（可复原性 4/10）**——Actions 未启用、服务账号错误都只能靠失败发现。修复：`hangzhou-release` 首步打印并断言 runner 身份（`whoami` = `nt authority\system`）、仓库与 `D:\beian` origin 一致；配合[迁移指南](../howto-repo-migration.md)与 F06 清单。
3. **[P1] 拒绝信息缺“下一步”（失败信息 6/10）**——每个停服前拒绝都应带“修复方式 + 文档锚点”，并写入 `$GITHUB_STEP_SUMMARY`，让 Mac 端 AI 用 `gh run view` 即可读到，不需要杭州转述。
4. **[P2] 预演覆盖停服后路径不足（预演 7/10）**——#3 的彩排只到 staging 探针；换位、UI 构建、恢复脚本仍是合成合同。修复：在 windows-2022 上用临时目录把 `Invoke-DependencySwap` → UI 构建 → `Restore-DependencyBackup` 也串成一次真实彩排（不碰生产路径）。
5. **[P2] 结果可见性与 staging 误导（可见性 6/10、预发 3/10）**——health 版本手写、Linux health 误报 AppleScript。修复：health 版本从 `VERSION` 读取或在 L0 断言一致；Linux 分支返回“本平台不支持打样”（TODOS F08）；合并后自动轮询 health 并在 PR 留言 SHA/run/version 三连（需评论授权时再做）。

## 5. 不在本次范围

- Python 依赖的离线交接（第一阶段明确拒绝，保持）。
- 把发布迁出杭州 Windows 或改用托管平台。
- 修改发布事务/恢复模型本身。

## 6. 已有可复用的部分

- 停服前的不可变 SHA、依赖图指纹、离线探针与 journal/watchdog 恢复事务（`scripts/windows/release.ps1`、`release-recover.ps1`）。
- windows-2022 合同 job 与 staging 彩排（`release-staging-rehearsal.ps1`）。
- 发布合同中“发版 L1 ≠ L2/UAT”的状态口径。

## 7. 自动选择的决定（TRIAGE 下替代交互提问）

| 问题 | 选择 | 理由 |
|---|---|---|
| 评审模式 | TRIAGE | 用户指定；生产刚恢复，聚焦阻塞项 |
| 是否给扩张性建议 | 否，仅列 5 项 | TRIAGE 不扩范围 |
| 待办写在哪里 | 只写 TODOS（B03、F06–F08） | docs/README 规定 TODOS 为唯一状态源 |
| 是否立即实现修复 | 否 | 本 PR 只改文档；实现另立 PR 并单独授权 |
