# 操作指南：仓库迁移与杭州 runner 重注册

适用：代码仓换 GitHub 账号/仓库，或杭州 self-hosted runner 需要重新注册时。本文记录 2026-10-10 从 `weiweity/beian`（账号封禁、仓库不可访问）迁到 `tyuanww/beian` 的实际顺序。它是操作指南，不是授权：每一步的仓库设置、生产机操作仍按 [发布合同](contracts/release.md) 和 [AGENTS.md](../AGENTS.md) 取得授权；合 `main` 会自动触发杭州发布。

## 结论先看

| 项 | 2026-10-10 状态 |
|---|---|
| 新仓 | `https://github.com/tyuanww/beian`，公开仓，PR 编号从 #1 重新开始 |
| Actions | 已启用（新仓默认未启用 workflow 时，`main` push 不会触发 `hangzhou-release`） |
| 杭州 runner | 名称 `hangzhou-windows`，标签 `hangzhou`，Windows 服务，账号 **LocalSystem** |
| `D:\beian` | `origin` 已改指 `https://github.com/tyuanww/beian` |
| 首次可信发版 | `0.31.1.1` / `c67d1a9`，run `38046344478` 成功，公网 health `0.31.1.1` |
| 主分支保护 | **未设置**（`GET branches/main/protection` → 404），见 TODOS B03 |
| secrets / 凭据轮换 / 外部镜像 | 未完成，见 TODOS F06 |

## 步骤

### 1. 迁代码（Mac）

1. 在新账号建空仓，不初始化 README。
2. 从完整的本地 clone 推送全部分支与标签：`git push --mirror <new-url>`，或至少 `git push <new> main --tags`。旧仓不可访问时，以本地最完整的 clone 为源，先核对 `git log -1 main` 与最后已知的生产 SHA 一致。
3. 本地各工作树执行 `git remote set-url origin https://github.com/tyuanww/beian`，`gh repo set-default tyuanww/beian`。
4. 历史 PR、Issue、Actions run 和评审对话不会随 git 迁移。仓内引用旧仓的 PR/run 链接保留为历史证据，不批量改写；在 TODOS 页首注明旧仓不可访问。

### 2. 打开 Actions 与仓库设置（GitHub，需仓库管理员）

1. Settings → Actions → General：允许 Actions 运行；`GITHUB_TOKEN` 默认只读（workflow 内已按需声明 `permissions`）。
2. 核对 `hangzhou-release.yml` 需要的 secrets/variables。当前只使用内置 `GITHUB_TOKEN` 下载发版组件；如今后增加 secret，必须在此清单中登记。
3. 重建 main 分支保护（必须 PR、必需检查 `quality` 与 `windows-powershell-contract`、strict、管理员受约束、禁止强推/删除、线性历史、对话解决）。**在保护建好之前，任何直推 main 都会立刻触发生产发版。**

### 3. 重注册杭州 runner（杭州机，交互式管理员 PowerShell）

1. 等在途对照/打样作业结束；不停 8787，不动隧道。
2. 在新仓 Settings → Actions → Runners → New self-hosted runner 取一次性注册令牌（只在杭州机使用，不贴到对话或仓库）。
3. 在 runner 目录先注销旧注册（旧仓不可访问时 `config.cmd remove` 可能失败，删除旧的 `.runner`/`.credentials` 后重配即可），再执行 `config.cmd --url https://github.com/tyuanww/beian --token <令牌> --name hangzhou-windows --labels hangzhou --runasservice`。
4. **改服务账号**：`--runasservice` 默认使用 `NETWORK SERVICE`。在 `services.msc` 中把 `actions.runner.*` 服务的登录身份改为“本地系统账户”（LocalSystem）并重启服务。`NETWORK SERVICE` 无法管理 WinSW 服务、计划任务和 `C:\supply\data\runtime\release` 的 ACL 目录，发版会失败。
5. Clash 系统代理开启时，runner 不能走 `127.0.0.1:7897`，见 [Windows README](../scripts/windows/README.md) 的代理说明。
6. 在 GitHub Runners 页确认 `hangzhou-windows` 为 Idle、标签含 `hangzhou`。

### 4. 改 `D:\beian` 的 origin（杭州机）

只改 remote，不 pull、不 reset：`git -C D:\beian remote set-url origin https://github.com/tyuanww/beian`，再 `git -C D:\beian fetch origin` 并只读核对 `origin/main` 与当前生产 SHA 的祖先关系。`release.ps1` 要求 ff-only，origin 指错会在停服前拒绝。

### 5. 用一次正常发版验收

经合并授权后合入一个 PR，观察：`hangzhou-release` 由 `main` push 触发并在 `hangzhou-windows` 上运行 → 绿 → 约 20 秒后公网 health 的 `version` 等于 VERSION。按发布合同记录 merge SHA、run id 与 health，写入 TODOS 页首。

## 迁移后仍要做的事

- 主分支保护（TODOS B03）。
- secrets、deploy key、webhook、Environments 逐项重建与回读；旧 runner/PAT/`gh` 令牌轮换或作废；GitHub 之外的镜像（TODOS F06）。
- 新仓是公开仓：确认仓内无密钥、真实稿和客户数据（这些本就只在杭州 `C:\supply\data`）。

## 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 合 main 后没有 `hangzhou-release` run | 新仓 Actions 未启用，或 workflow 被禁用 | 启用 Actions；只对那条可信 push run 重跑 |
| run 一直 Queued | runner 离线/注册在旧仓/标签不符 | 按第 3 步重注册，标签 `hangzhou` |
| run 在发版脚本里报权限/服务控制错误 | runner 服务账号是 `NETWORK SERVICE` | 改为 LocalSystem 并重启 runner 服务 |
| `Runner connect error` | runner 走了 Clash 代理 | 设 DIRECT 或关掉系统代理 |
| 停服前因 ff-only 拒绝 | `D:\beian` origin 仍指旧仓或历史不连续 | 改 origin 并只读核对祖先关系 |
