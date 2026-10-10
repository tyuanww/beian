# 设计文档：Windows 生产发版的「离线依赖交接」（Offline Dependency Handoff）

> 状态：草案（仅设计，不含实现代码改动）
> 适用：`scripts/windows/release.ps1`、`scripts/windows/release-recover.ps1`、`scripts/windows/release-dependency-check.mjs`、`.github/workflows/hangzhou-release.yml`
> 触发事件：0.31.0.0（`5a9d79d`）发版在停服前失败：`Assert-OfflineDependencyHandoff` 第 210 行抛出「真实 npm 依赖图变化，但当前发版没有离线 node_modules 快照；拒绝停 8787」。
> 行号均以当前源码快照（`src.tgz`）为准。

---

## 0. 结论速览

| 决策点 | 结论 |
|---|---|
| npm 依赖变化 | **支持**：8787 在线时在 `D:\beian-deps\stage-<targetSha>` 用目标 SHA 的源码导出 + `npm ci` 构建完整依赖树，离线验证全部通过后才允许停服 |
| 交接方式 | 停服后、`merged` 之后、`ui_build` 之前，对 3 个目录做同卷 `Directory.Move` 原子换位（live→backup，staged→live） |
| Python requirements 变化 | **第一期继续拒绝**（保留第 212–219 行），理由见 §6；0.31.0.0 不涉及 |
| 回滚 | `release-recover.ps1` 先把 backup 换回 live，再 `git reset`，再跑旧版离线探针（现有第 873 行） |
| 依赖图不变 | 完全走今天的路径，不建 staging、不写新 journal 语义（新字段为空值） |
| 依赖安装的唯一联网点 | 停服前的 `npm ci`（staging 内）；停服后仍然零 npm/PyPI 访问 |
| 0.31.0.0 上线 | 本修复合入 main 后产生的**新 push** 才能发版；已排队的 `5a9d79d` run 绑定旧 `release.ps1`，会在停服前再次安全失败 |

---

## 1. 背景与问题

### 1.1 当前模型

`release.ps1` 把一次发版拆成两段：

1. **停服前（8787 在线，可安全失败）**：第 1200–1243 行。fetch、锁定 `TargetSha`、恢复 `package-lock.json` 工作树、检查分支/脏树/ahead、`Assert-OfflineDependencyHandoff`（202–238）、`Assert-OfflineRuntimeIntegrity`（296–341）、`Snapshot-UiDist`（343–356）、Git 锁检查。
2. **恢复事务（停服后，必须可离线回滚）**：drain → `Arm-ReleaseRecovery`（996–1049，写 journal + SYSTEM watchdog）→ `Promote-ReleaseDrain` → 停服（1314–1325）→ Agent Quiesce（1331–1336）→ `Arm-GitMergeTransaction` + ff-only（1338–1352）→ 再次依赖核对（1355）→ UI 构建（1358–1361）→ Agent 同步 → 启动 → 冒烟 → `Commit-ReleaseRecovery`（1051）→ `Disarm-ReleaseRecovery`（1062）。

核心不变量：**停服之后不访问 npm/PyPI**（README 第 104 行、`docs/contracts/release.md` 第 26 行）。依赖变化时 `Get-NpmDependencyGraphFingerprint`（166–182，调用 `release-dependency-check.mjs fingerprint`，哈希 = 规范化 `package-lock.json`（去根版本号）+ 三个 manifest 的依赖字段）前后不等就直接拒绝。

journal 已预留 `dependency_mutated`（1030）与 `python_mutated`（1032）字段，但恢复脚本第 837–839 行看到它们为 true 会直接放弃（"offline rollback cannot be proven"）。

### 1.2 本次差异（0.30.3.3 `eb2ceb8` → 0.31.0.0 `5a9d79d`）

| 项 | 变化 | 风险 |
|---|---|---|
| `apps/web/server` | 新增 `sharp@0.34.4` | 原生模块；Windows 通过可选依赖 `@img/sharp-win32-x64`（内置 libvips DLL）提供预编译二进制 |
| `apps/web/ui` | 移除 `dayjs` | 纯 JS，低风险；但 antd 可能仍间接依赖 dayjs，需以 lock 为准 |
| `package-lock.json` | 约 557 行变化 | 依赖图指纹必然变化 |
| `requirements.txt` | 无变化 | Python 路径不受影响 |

### 1.3 约束（不可违背）

- 合同禁止：手工 pull/重启、在杭州本地手跑 `release.ps1`、`git reset --hard`（Agent 侧）。唯一入口是 `hangzhou-release.yml` 在 `push main` 时下载事件 SHA 的脚本到 `RUNNER_TEMP` 执行。
- 停服前不能写 `D:\beian` 的 index/工作树（`Restore-NpmLockfileWorktree` 是唯一例外，只恢复为 HEAD blob）。
- GitHub-hosted runner（`quality.yml` 的 `windows-2022`）绝不触达生产。

---

## 2. 目标与非目标

**目标**

1. npm 依赖图变化的版本可以经由同一条 CD 自动上线，且停服后零联网。
2. 失败在停服前发生时，生产无感（8787 继续服务，drain 解除）。
3. 停服后任一时刻崩溃（Actions 取消、PowerShell 被杀、掉电），watchdog 都能把系统恢复为「旧 SHA + 旧 node_modules + 旧 UI dist」并通过旧版离线探针。
4. 依赖图不变时行为与今天逐字节等价。

**非目标**

- Python venv 的离线交接（第二期，见 §6）。
- Node.js 运行时本身（`node.exe`）升级。
- 改变 drain / fence / committed 的语义。

---

## 3. 总体流程

```
[8787 在线]
 Fetch/Resolve TargetSha ─ Restore lockfile ─ 分支/脏树/ahead 检查
 └─ Get-DependencyHandoffPlan(preSha, TargetSha)
      ├─ 指纹相等 ─────────────────────────► 今天的路径（Assert-OfflineDependencyHandoff 原样）
      └─ 指纹不等 + requirements 不变
           ├─ Assert-DependencyStagingPreconditions（磁盘、路径、ACL、旧 staging 清理）
           ├─ New-StagedSourceExport   (git archive TargetSha → stage\src)
           ├─ Invoke-StagedNpmCi       (唯一联网步骤，带超时)
           ├─ Repoint-StagedWorkspaceLinks (junction → D:\beian\apps\web\*)
           ├─ Assert-StagedOfflineIntegrity (断网探针 + 指纹 + sharp + vite build)
           └─ Write-StagedDependencyStamp
 Assert-OfflineRuntimeIntegrity（对旧 live 树，原样） ─ Snapshot-UiDist ─ Git 锁检查
 drain → Arm-ReleaseRecovery（新增 deps_* 字段）→ Promote fence
[停服]
 stopping → stopped → agent_quiesce → merging → merged
 └─ (仅依赖变化) deps_swap：dependency_mutated=true 先落盘 → 逐目录换位 → deps_swapped
 Assert-LiveDependencyMatchesTarget（替代 1355 行的“未变”断言）
 ui_build → agent_sync → starting → smoke → committed → Disarm（保留 backup，见 §9）
```

---

## 4. 停服前：Staging

### 4.1 位置选择

| 候选 | 评价 |
|---|---|
| `C:\supply\data\runtime\release\...`（ACL 运行时目录） | **否决**：与 `D:\beian` 不同卷，`Directory.Move` 跨卷会失败（或退化为非原子复制）；且 `release-recover.ps1` 第 932–935 行会在 journal 消失后尝试删除整个运行时目录，混放大目录会让这一逻辑复杂化 |
| `D:\beian\` 内部（如 `.release-staging`） | **否决**：落在仓库内，`git status --untracked-files=no` 虽不报，但 tsx/vite/Knip 等可能扫描；`Test-DataDirInsideRepo` 的精神也是数据不进仓库 |
| **`D:\beian-deps\`（与仓库同卷的兄弟目录）** | **采用**。同卷保证原子 rename；在仓库外；可单独设 ACL |

目录布局：

```
D:\beian-deps\
  stage-<targetSha>\            # 本次 staging（完整源码导出 + node_modules）
    src\                        # git archive TargetSha 的导出
      package.json, package-lock.json
      apps\web\ui\...  apps\web\server\...
      node_modules\             # npm ci 产物（根）
      apps\web\ui\node_modules\     # 若 npm 产生非提升依赖
      apps\web\server\node_modules\ # 同上
    npm-cache\                  # 本次专用 npm cache，不污染 LocalSystem profile
    stamp.json                  # 见 4.6
    logs\npm-ci.log
  backup-<preSha>-<utc>\        # 停服后换位产生的旧 live 依赖
  failed-<targetSha>-<utc>\     # 回滚时被换下的目标依赖（便于事后诊断）
```

实际上 3 个目录（根、ui、server 的 `node_modules`）构成「依赖集合」`DepSet`。在 staging 中只要某个工作区级 `node_modules` 不存在，就记为 `absent`，换位时同样处理（见 §7.2）。

### 4.2 源码获取（不碰 D:\beian 的 index/工作树）

- 使用 `git -C D:\beian archive --format=tar <TargetSha>` 导出到 `stage\src`（Windows 自带 `tar.exe` 解包）。`git archive` 只读对象库，不写 index、不建 worktree 元数据（`git worktree add` 会写 `.git\worktrees`，故不用）。
- 为什么导出完整源码而非只取 3 个 `package.json` + lock：
  1. `npm ci` 需要工作区目录真实存在才能建工作区链接；
  2. 后续探针要 `tsx` 导入**目标版本**的真实服务入口 `apps/web/server/src/index.ts`，并对**目标 UI** 做 `vite build`；用旧源码 + 新依赖会测错对象。
- 导出后，用 `release-dependency-check.mjs fingerprint` 对 `TargetSha` 计算指纹（现有逻辑），并新增子命令（见 4.5）对导出目录的文件计算同一投影，二者必须相等，防止导出与 SHA 不一致。

### 4.3 `npm ci`（唯一联网步骤）

建议参数与环境：

| 设置 | 值 | 理由 |
|---|---|---|
| 工作目录 | `stage\src` | 与 live 完全隔离 |
| 命令 | `npm ci --no-audit --no-fund --include=dev --include=optional --foreground-scripts` | UI 构建需要 devDependencies（vite、typescript、@vitejs/plugin-react）；tsx 在 server devDependencies；可选依赖承载所有 win32 原生包 |
| `--cache` | `D:\beian-deps\stage-<sha>\npm-cache` | LocalSystem 的默认 cache 在 `C:\Windows\System32\config\systemprofile\AppData`，不可预测且可能被污染；专用 cache 用后即删 |
| `npm_config_os` / `cpu` | 不设置（让 npm 按 win32/x64 解析） | 防止误装其它平台二进制 |
| install scripts | **待决**（见开放问题 Q3）。默认建议**允许**（sharp 0.34 的 install 脚本在有预编译包时只做校验，不下载；esbuild 的 postinstall 会校验二进制）。若改为 `--ignore-scripts`，必须依赖 4.4 的探针兜底 |
| 超时 | 15 分钟硬上限，用 `Start-Process` + `WaitForExit(ms)`，超时杀进程树（可复用 RF-11 的 Job Object 思路） | 不让 Actions 40 分钟 `timeout-minutes` 被 staging 吃光 |
| 代理（Clash） | 透传 runner 进程已有的 `HTTPS_PROXY/HTTP_PROXY`；保持 `NO_PROXY=127.0.0.1,localhost`（第 34 行）；**不**在脚本里硬编码代理地址；日志中打印是否设置代理但不打印值 | 杭州现网依赖 Clash；`git fetch` 已经走同一出口 |
| 输出 | 重定向到 `logs\npm-ci.log`，失败时只回显末尾 40 行 | 避免 Actions 日志被刷屏；不含 token |

`npm ci` 会严格按 lock 安装，lock 与 manifest 不一致时自己失败，这正是期望的「停服前失败」。

**注意 npm 已知坑**：在 Mac 上生成的 lock 有时缺少 win32 的可选平台包条目（npm/cli#4828）。0.31 的 lock 是否含 `@img/sharp-win32-x64`、`@rollup/rollup-win32-x64-msvc`、`@esbuild/win32-x64` 条目需在 PR 阶段核对（见 §11 测试）；运行时由探针兜底。

### 4.4 工作区链接（junction）处理

npm workspaces 在 Windows 上把 `node_modules\beian-ui`、`node_modules\beian-server` 建成 **junction，目标是绝对路径**（即 `D:\beian-deps\stage-<sha>\src\apps\web\ui`）。整体换位到 `D:\beian\node_modules` 后这些 junction 仍指向 staging 目录，造成：

- 运行时实际从 staging 源码加载工作区包（若有代码按包名 import 工作区）；
- 删除 staging 后 junction 悬空，`npm ls` 失败。

方案：探针**通过后**、停服**之前**执行 `Repoint-StagedWorkspaceLinks`：

1. 枚举 `stage\src\node_modules` 下所有 reparse point（`Get-ChildItem -Attributes ReparsePoint`，同时检查 `@scope` 子目录）；
2. 仅允许目标位于 `stage\src\` 内部的 junction（白名单：`beian-ui`、`beian-server`），其余 reparse point 一律视为异常并失败；
3. 删除 junction 本身（`[System.IO.Directory]::Delete(path, $false)`，**绝不递归**，否则会删穿到源码），重建为指向 `D:\beian\apps\web\ui|server` 的 junction（`New-Item -ItemType Junction`）；
4. 记录每个 junction 的「名称 → 最终目标」到 `stamp.json`。

重建后的 junction 指向 live 仓库中**当前（旧）版本**的工作区源码，停服前它们不会被任何进程使用；merge 后自然指向新源码。换位后由 `Assert-LiveDependencyMatchesTarget` 复核 junction 目标。

> 同理，**删除/清理任何 node_modules 目录**时都必须先拆 junction 再递归删除。现有 `Remove-Item -Recurse` 在 PS5.1 上对 junction 的行为不可靠（可能跟随进入目标）。这是实现时的硬性要求，应有单测锁定（§11）。

`.bin\*.cmd` shim 使用 `%~dp0` 相对路径，搬迁后无需修复；`node_modules\.package-lock.json`（npm 隐藏 lock）只含相对路径，也无需修复。

### 4.5 离线验证（停服前，针对 staging）

新增 `Assert-StagedOfflineIntegrity`，与 `Assert-OfflineRuntimeIntegrity`（296–341）同构，但 `$Root = stage\src`，并在**断网条件**下运行：

| 断网措施 | 说明 |
|---|---|
| `npm_config_offline=true` | npm 自身不发请求 |
| `HTTP_PROXY/HTTPS_PROXY/http_proxy/https_proxy=http://127.0.0.1:9`，`NO_PROXY=127.0.0.1,localhost` | 遵守代理变量的库会立即连接失败而不是悄悄联网 |
| `npm_config_registry=http://127.0.0.1:9/` | 双保险 |
| `--cache` 指向一个空的临时目录 | 证明不依赖 cache |
| （可选）Windows 防火墙按程序拦截 | 需要管理员策略改动，**不建议**在 CD 中做；列为开放问题 Q6 |

探针列表（任一失败 → 停服前失败，删除 staging，drain 未进入或已解除）：

| # | 探针 | 实现要点 |
|---|---|---|
| P1 | 依赖图指纹 | `release-dependency-check.mjs fingerprint D:\beian <TargetSha>` == 新增子命令 `installed <stage\src>` 的结果。`installed` 读取 `node_modules\.package-lock.json`，对每个 `packages[path]` 投影 `version/resolved/integrity/link/optional/dev`，与目标 `package-lock.json` 中同 path 条目比对；目标中有、而本平台可选跳过的条目（`os/cpu` 不匹配）允许缺失，其余必须一一对应 |
| P2 | `npm ls --all --offline --ignore-scripts --silent` | 与第 317 行相同 |
| P3 | `tsx --version` | 与第 318 行相同 |
| P4 | 服务入口导入 | 复用 `Assert-IsolatedServerEntryImport`（270–294），工作目录换成 `stage\src`；它会真实加载 `sharp`（若入口静态 import） |
| P5 | `require('sharp')` + 真实解码 | `node -e` 在 `stage\src\apps\web\server` 下 `require('sharp')`，并对 `apps/web/ui/public/brand/logo-mark.png`（或任一仓库内小 PNG）调用 `.metadata()`；断言 `sharp.versions.vips` 非空、`process.platform==='win32'`。这证明 `@img/sharp-win32-x64` 与 libvips DLL 可加载 |
| P6 | Vite CLI + Rollup 原生 | 与 320–321 行相同（`@rollup/rollup-win32-x64-msvc\*.node`） |
| P7 | **完整 UI 构建 dry-run** | 在 `stage\src` 执行 `npm run build -w beian-ui -- --outDir <stage>\ui-dist-probe --emptyOutDir`（含 `tsc --noEmit`）。这是停服后 `ui_build`（1360 行）的同一命令，提前证明新依赖 + 新源码能离线构建；顺带证明 `dayjs` 移除后无残留 import。产物不使用，只在日志记录指纹 |
| P8 | 平台二进制存在性 | `@img/sharp-win32-x64`、`@rollup/rollup-win32-x64-msvc`、`@esbuild/win32-x64` 三个目录存在且含 `.node`/`.exe`/`.dll` |

P1–P8 的耗时估计：P7 约 1–2 分钟，其余合计 < 1 分钟。

### 4.6 Stamp 与防篡改

`stamp.json`（UTF-8 无 BOM，原子写入）：

```json
{
  "protocol": "beian.deps-stage.v1",
  "target_sha": "...",
  "target_npm_fingerprint": "...",
  "installed_fingerprint": "...",
  "depset": { "node_modules": "present", "apps/web/ui/node_modules": "absent", "apps/web/server/node_modules": "present" },
  "junctions": { "node_modules/beian-ui": "D:\\beian\\apps\\web\\ui", "node_modules/beian-server": "D:\\beian\\apps\\web\\server" },
  "node_version": "v22.x", "npm_version": "10.x",
  "verified_at": "..."
}
```

`stamp.json` 也复制一份到 `C:\supply\data\runtime\release\deps-stage.json`（ACL 目录内），journal 记录其 SHA-256。换位前再快速比对一次 `installed` 指纹（读隐藏 lock，秒级），不做全量文件哈希（几万文件，代价过高）。

### 4.7 ACL

- `D:\beian-deps` 根目录 ACL **复制 `D:\beian` 的 ACL**（而不是 `Set-ReleaseRuntimeAcl` 的 SYSTEM+Administrators 保护 ACL）。
- 理由：NTFS 同卷 move 会保留对象上的 ACE。如果 staging 是「仅 SYSTEM/Admins」，换位后 live `node_modules` 也会是这个 ACL，可能导致非 SYSTEM 进程（Session 1 InteractiveToken 的 Illustrator Agent 或运维账号的只读排查）无法读取。复制仓库 ACL 让换位对权限透明，篡改面与现有 `D:\beian` 相同，不新增风险。
- 若 `D:\beian` 本身的 ACL 允许低权限用户写入，那是既有风险，单列开放问题 Q5。

### 4.8 磁盘空间

- 在 staging 开始前计算：`need = 2.5 × size(live DepSet) + 2 GB`（staging + 保留一代 backup + npm-cache + UI probe 余量），`D:` 可用空间不足即停服前失败。
- 首次发版无法知道新树大小，以旧树大小近似；`npm ci` 后再检查一次剩余空间 ≥ 1 GB。

### 4.9 Staging 的生命周期与重入

- 每次发版开始时（拿到 `release.lock` 之后，第 1189 行之后），若不存在 journal：删除 `D:\beian-deps\stage-*`（除非与本次 `TargetSha` 相同且下面的复用条件成立）。
- **复用**（可选优化，见 Q4）：同一 SHA 的重跑可复用已有 staging，但必须重跑 P1–P8 全部探针；不复用 stamp 作为通过证据。
- 停服前任何失败：删除本次 staging（先拆 junction）。失败的清理只告警，不覆盖首个异常（与 `Remove-UnarmedReleaseRuntime` 1095–1134 的原则一致）。

---

## 5. 停服后：换位（Swap）

### 5.1 放在哪个阶段

选择 **`merged` 之后、`ui_build` 之前**，新增 journal 阶段 `deps_swap` → `deps_swapped`。

| 备选位置 | 评价 |
|---|---|
| `stopped` 之后、`agent_quiesce` 之前 | 换位时 Agent 可能仍在运行并持有 node_modules 文件句柄（若 Agent 有用到 node），rename 会因句柄失败 |
| `agent_quiesce` 之后、`merging` 之前 | 可行；但此时工作树仍是旧 lock，若 merge 失败就要换回来，多做一次无意义的回滚 |
| **`merged` 之后、`ui_build` 之前** | 采用。此时 HEAD 已等于 TargetSha，工作树 lock 与新依赖一致；`ui_build` 首次需要新依赖；merge 失败时依赖未动，恢复路径与今天一致 |

### 5.2 换位步骤（`Invoke-DependencySwap`）

前置：`Assert-NoProcessHoldsDepSet`——枚举 `Win32_Process`，命令行或可执行路径位于 `D:\beian\node_modules`、`D:\beian\apps\web\*\node_modules`、`D:\beian-deps` 下的进程存在即失败（类似 `Get-LegacyOfflineBlockers` 第 764–776 行，跳过自身祖先）。

1. `$ReleaseJournalState.dependency_mutated = $true`；`Set-ReleaseJournalStage "deps_swap"`（**先落盘再动目录**，与 `ui_mutated`（1358）、`agent_mutated`（1331）同一写前日志模式）。
2. 对 `DepSet` 中每个相对路径 `rel`，按固定顺序（server → ui → 根）：
   - a. 若 live `D:\beian\<rel>` 存在：`[System.IO.Directory]::Move(live, backup\<rel>)`；不存在则在 backup 下写 `<rel>.absent` 标记文件。
   - b. 若 staged `stage\src\<rel>` 存在：`Move(staged, live)`；为 `absent` 则跳过。
   - c. 每个 `rel` 完成后在 journal 的 `deps_swap_progress` 中记录 `rel: "swapped"` 并原子写入。
3. `Set-ReleaseJournalStage "deps_swapped"`。
4. `Assert-LiveDependencyMatchesTarget`：`installed D:\beian` 指纹 == `deps_new_fingerprint`；junction 目标逐一核对；然后对 live 运行一次 `Assert-OfflineRuntimeIntegrity`（296–341，**此时 HEAD 已是目标**，因此它就是「目标版本冷启动」探针，替代第 1355 行对 `Assert-OfflineDependencyHandoff` 的调用）。

为什么顺序是 server → ui → 根：根 `node_modules` 里有指向工作区的 junction 和 `.bin`，最后换根能让「部分换位」状态下根仍是旧的完整树，`npm ls` 失败更明确，也便于恢复时判断。

> `Directory.Move` 在同卷内是一次 MFT rename，原子；源目录里有被打开的文件时会抛 `IOException`，此时不会出现半移动状态，直接进入恢复。

### 5.3 与 `Assert-OfflineDependencyHandoff` 的关系

把现有函数拆成两个：

- `Get-DependencyHandoffPlan($from, $to)` → 返回 `{ Mode = "unchanged" | "npm-staged"; FromFingerprint; ToFingerprint }`；Python requirements 变化仍抛错（第 212–219 行原样）。
- `Assert-OfflineDependencyHandoff` 保留其余检查（220–237：node_modules 存在、Rollup、Python、旧 dist），只在 `Mode=unchanged` 时要求指纹相等。

第 1355–1356 行（merge 后再次断言「依赖图未变」）改为按 plan 分支：

- `unchanged`：保持原调用与日志文本。
- `npm-staged`：执行 §5.2，日志 `dependency graph changed; swapped verified offline node_modules from <stage>`。

### 5.4 Journal 新字段

在 `Arm-ReleaseRecovery`（1005–1046）中新增（依赖不变时全部为空字符串/`$false`，向后兼容）：

| 字段 | 含义 |
|---|---|
| `deps_mode` | `"unchanged"` / `"npm-staged"` |
| `deps_old_fingerprint` | `preSha` 的 npm 指纹 |
| `deps_new_fingerprint` | `TargetSha` 的 npm 指纹 |
| `deps_root` | `D:\beian-deps`（恢复时 `Assert-PathUnder` 的信任根） |
| `deps_stage_path` | `D:\beian-deps\stage-<targetSha>\src` |
| `deps_backup_path` | `D:\beian-deps\backup-<preSha>-<utc>`（arm 时就确定，目录在换位时才创建） |
| `deps_failed_path` | `D:\beian-deps\failed-<targetSha>-<utc>`（恢复时使用） |
| `deps_set` | `["apps/web/server/node_modules","apps/web/ui/node_modules","node_modules"]` 及每项 staged 是否 present |
| `deps_stage_stamp_sha256` | `deps-stage.json` 哈希 |
| `deps_swap_progress` | `{rel: "pending"|"backed_up"|"swapped"}` |
| `dependency_mutated` | 已有字段（1030），换位前置 true |

协议号可保持 `beian.release-recovery.v1`：旧恢复脚本看到 `dependency_mutated=true` 会安全拒绝（837 行）而不是乱动——但因为恢复脚本总是与 `release.ps1` 同 SHA 下发（`Prepare-ReleaseRecoveryRuntime` 960 行），实际不会出现新旧混用。若希望显式，可升级为 `v2` 并让新脚本兼容读 `v1`（开放问题 Q7）。

---

## 6. Python：第一期继续拒绝

决定：**保留** `Assert-OfflineDependencyHandoff` 第 212–219 行对 `requirements.txt` 变化的拒绝；第一期不实现 venv staging。

理由：

1. **venv 不可安全重定位**。`.venv\pyvenv.cfg` 记录基础解释器 `home`；`Scripts\*.exe` 控制台入口（pip.exe 等）内嵌绝对路径；部分包写入 `.pth`/`RECORD` 绝对路径。在兄弟目录建好再 rename，等价于移动 venv，官方不支持。要可靠只能在**最终路径**原地构建，这与「停服前不动 live」矛盾。
2. **WB_PYTHON 固定路径**（`hangzhou-release.yml` 的 `WB_PYTHON: D:\beian\apps\web\backend\.venv\Scripts\python.exe`，Blender 冒烟第 1431 行也用它）。改为版本化目录（如 `.venv-<hash>` + 指针）需要同步改 WinSW 配置、Agent、workflow，范围远超本次。
3. **需求不紧迫**。0.31.0.0 requirements 未变；Python 依赖历史上变化频率低。
4. **风险不对称**。Python 包（pymupdf、shapely、Pillow）都是原生 wheel，失败模式多（缺 VC++ 运行库、wheel 平台标签），值得独立设计与实测。

第二期方向（备忘，不在本次范围）：版本化 venv `D:\beian-deps\venv-<reqhash>`，用 `python -m venv` 在**最终目录**构建（目录名即最终路径，无需移动），通过 WinSW/环境变量指向；`pip install --require-hashes -r` + `pip check` + `import app.cli; import fitz; import openpyxl`（与 331 行相同）探针；回滚只需切回旧指针。届时 `python_mutated`（1032）字段启用。

文档需写明：Python 依赖变化仍需「独立运维变更」（README 第 104 行原文保留，限定为 Python）。

---

## 7. 恢复（`release-recover.ps1`）

### 7.1 修改点

| 位置 | 现状 | 变更 |
|---|---|---|
| 第 782–835 行 快速路径 | 仅 `armed/stopping/stopped/failed/recovery_failed` 且未 armed Git 事务 | 增加条件 `-not dependency_mutated`。实际上换位发生在 `merged` 之后，Git 事务必已 armed，快速路径本就不会命中；显式加条件作为防御 |
| 第 837–839 行 | `dependency_mutated` 或 `python_mutated` 为真直接抛错 | 改为：`python_mutated` 仍抛错；`dependency_mutated` 时校验 journal 的 `deps_*` 字段（`Assert-PathUnder` 到 `deps_root`，`deps_root` 必须与 `root` 同卷且不在 `root` 内），否则抛错 |
| 第 840–842 行 | 要求 live `node_modules` 存在 | `dependency_mutated` 时推迟到依赖恢复之后再检查 |
| 第 857–861 行之间 | Stop → Quiesce → Restore UI | 插入 `Restore-DependencyBackup`：**Stop-BeianService 与 Agent Quiesce 之后、Restore-UiSnapshot 与 git reset 之前** |
| 第 873 行 | 对旧树跑离线探针 | 先追加 `installed D:\beian` 指纹 == `deps_old_fingerprint` 断言（使用 journal 记录的 runtime checker，哈希已在 1040 行登记），再跑原探针 |
| 第 648–663 行 `Remove-WatchdogArtifacts` | 删除运行时文件 | 增加删除 `deps-stage.json`；**不删除** `D:\beian-deps` 下的大目录（交给下次发版的保留策略，避免恢复脚本做长时间递归删除） |
| 第 740–781 行 committed 分支 | 重启目标 | 不变；committed 后绝不换回旧依赖 |

为什么依赖恢复要在 `git reset` 之前：`git reset --hard` 不会触碰 `node_modules`（被忽略），顺序上不强依赖；但把「最慢、最可能因句柄失败」的步骤放在 reset 前，失败时 HEAD 仍是目标 SHA、依赖状态由 journal 精确描述，重试幂等更容易证明。同时 Stop-BeianService 必须在前，保证没有 node 进程持有文件。

### 7.2 `Restore-DependencyBackup` 的幂等算法

对 `deps_set` 中每个 `rel`（顺序与换位相反：根 → ui → server），依据**磁盘事实**而不是只依据 `deps_swap_progress`（进度可能落后于实际 rename 一步）：

| live 存在? | backup\<rel> 存在? | backup\<rel>.absent? | 判定 | 动作 |
|---|---|---|---|---|
| 是 | 否 | 否 | 尚未备份（换位未到此项） | 无动作 |
| 是 | 是 | – | live 是目标树，backup 是旧树 | `Move(live, failed\<rel>)`，再 `Move(backup\<rel>, live)` |
| 否 | 是 | – | 备份完成但 staged 未移入（或已移出到 failed） | `Move(backup\<rel>, live)` |
| 是 | 否 | 是 | 旧 live 原本不存在，live 是目标树 | `Move(live, failed\<rel>)`，删除 `.absent` 标记 |
| 否 | 否 | 是 | 旧 live 原本不存在且已清空 | 删除 `.absent` 标记 |
| 否 | 否 | 否 | **异常：旧树丢失** | 抛错，`recovery_failed`，8787 保持停止，等待人工 |

区分「live 是目标树还是旧树」时不靠猜：读取 `live\.package-lock.json`（仅根有意义）或比较目录的 NTFS FileId 与 backup 是否同一对象不可行，因此**以 backup 是否存在为准**——换位严格先移走 live 再移入 staged，backup 存在即意味着 live（若存在）只能是 staged 移入的。全部完成后以 `installed` 指纹 == `deps_old_fingerprint` 最终确认。

每个 rename 之后更新 journal `deps_swap_progress[rel] = "restored"`。重复执行时以上表重新判定，结果收敛。

### 7.3 崩溃点分析

记号：OLD = 0.30.3.3 依赖，NEW = 0.31 依赖。

| # | 崩溃时刻（journal stage） | 磁盘状态 | 恢复行为 | 最终状态 |
|---|---|---|---|---|
| 1 | staging 中（无 journal） | 8787 运行；staging 半成品 | 无 journal → 无恢复；drain 尚未进入；下次发版清理 staging | OLD 在线，无影响 |
| 2 | staging 探针通过后、`Enter-ReleaseDrain` 前 | 同上，staging 完整 | 同上 | OLD 在线 |
| 3 | drain lease 期间、journal 前 | drain 2 分钟租约 | 租约到期自动开放（既有行为） | OLD 在线 |
| 4 | `armed`/`stopping`/`stopped` | 依赖未动 | 快速路径（782–835） | OLD 在线 |
| 5 | `agent_quiesce`/`merging` | 依赖未动，可能有 Git 锁 | 既有全量恢复；`dependency_mutated=false` 跳过依赖恢复 | OLD 在线 |
| 6 | `merged`，未进 `deps_swap` | 依赖未动，HEAD=NEW | 既有全量恢复 | OLD 在线 |
| 7 | `deps_swap` 已落盘、首个 Move 前 | 依赖未动；backup 目录不存在 | 7.2 表第 1 行：每项无动作；指纹 == OLD 通过 | OLD 在线 |
| 8 | server 项 live→backup 后、staged→live 前 | `server\node_modules` 缺失，backup 有 | 表第 3 行：移回 | OLD 在线 |
| 9 | server 项完成，ui/根未动 | server=NEW，其余 OLD | 表第 2 行处理 server；其余第 1 行 | OLD 在线 |
| 10 | 根项 live→backup 后、staged→live 前 | 根缺失 | 表第 3 行 | OLD 在线 |
| 11 | `deps_swapped`，`Assert-LiveDependencyMatchesTarget` 失败 | 全 NEW | 全部按表第 2 行换回 | OLD 在线；NEW 留在 `failed-*` 供诊断 |
| 12 | `ui_build` 中 | 全 NEW，dist 半成品 | 依赖换回 → UI 快照恢复 → reset → 旧探针 | OLD 在线 |
| 13 | `agent_sync`/`starting`/`smoke` | NEW 运行或已停 | Stop-BeianService 后同 #12 | OLD 在线 |
| 14 | `committed` 之后 | NEW 已验证 | committed 分支：只重启 NEW，不换回 | NEW 在线；backup 保留 |
| 15 | 恢复进行中崩溃（`recovering`） | 任意中间态 | watchdog 下一分钟重跑；7.2 判定收敛 | OLD 在线 |
| 16 | 恢复时 Move 因句柄失败 | 部分换回 | `recovery_failed`，watchdog 重试；8787 保持停止直到成功（不会用不完整依赖启动） | 重试成功后 OLD 在线 |
| 17 | 恢复时发现旧树丢失（表最后一行） | 不可证明 | 抛错保持现场，8787 停止 | 需人工（与现有 Git 锁不可证明时的处理一致） |

关键性质：**在 `committed` 之前，任何时刻 8787 只会以「OLD 依赖 + OLD SHA + OLD dist」或「NEW 依赖 + NEW SHA + NEW dist 且在 transaction fence 下冒烟」两种组合启动**。

---

## 8. 并发、锁与超时

- **release.lock**：staging 全程在 `Acquire-ReleaseLock`（1071，主流程 1189 行）之后进行，因此同一时刻只有一个发版/恢复在操作 `D:\beian-deps`。Actions `concurrency: hangzhou-production`（`cancel-in-progress: false`）进一步串行化。
- **恢复脚本**：已在锁内重读 journal（691–703 行）；`deps_*` 字段只从锁内快照读取，满足「锁前快照不能授权」的现有原则。
- **watchdog 与 staging**：staging 发生在 journal 之前，watchdog 尚未注册，不会误触发。
- **时间预算**（`hangzhou-release.yml` `timeout-minutes: 40`）：

| 阶段 | 估计 |
|---|---|
| fetch + 预检 + 旧树探针 + UI 快照 | 2–3 分钟 |
| staging：archive + `npm ci` | 3–10 分钟（上限 15） |
| staging 探针（含 UI 构建 dry-run） | 2–3 分钟 |
| drain 等待 | ≤ 15 秒（60×250ms） |
| 停服后：换位 + 目标探针 + UI 构建 + 启动 + Illustrator + Blender（≈63s）冒烟 | 4–6 分钟 |
| 合计 | 约 12–22 分钟，最坏约 30 分钟 |

建议将 `timeout-minutes` 提升到 **60**（开放问题 Q2），使 15 分钟 `npm ci` 上限不会把停服后阶段挤到超时边缘。即便 Actions 超时杀掉进程，停服后由 watchdog 接管（既有保证），停服前被杀则 8787 不受影响。

- **watchdog 单次执行上限**为 30 分钟（984 行）；依赖恢复只是若干 rename，秒级完成。

---

## 9. 清理与保留

| 目录 | 何时删除 | 谁删除 |
|---|---|---|
| `stage-<sha>` | 换位成功后已变为空壳（`src` 下只剩源码导出）；在 `Disarm-ReleaseRecovery` 之后删除。停服前失败时立即删除 | `release.ps1` |
| `npm-cache` | 同上 | `release.ps1` |
| `backup-<preSha>-*` | **保留最近 1 代**，下一次依赖变化发版在停服前、磁盘检查前删除更早的代 | `release.ps1` |
| `failed-<targetSha>-*` | 保留最近 1 代，同上 | `release.ps1` |
| `deps-stage.json`（ACL 目录内） | 与 journal 同生命周期 | `Disarm-ReleaseRecovery` / `Remove-WatchdogArtifacts` / `Remove-UnarmedReleaseRuntime` |

删除前一律先拆 junction（§4.4）。删除只限 `D:\beian-deps` 下、名称匹配 `^(stage|backup|failed)-[0-9a-f]{40}(-\d{8}T\d{6}Z)?$` 的目录，不认识的条目保留并告警（与 `Remove-UnarmedReleaseRuntime` 对未知运行时文件的态度一致）。

为什么 committed 后仍保留 backup：committed 是不可逆点，脚本不会再用它；但它是人工应急的最快手段（比重新联网 `npm ci` 旧 lock 快且确定），代价只是一份磁盘。是否保留由用户决定（Q4）。

---

## 10. 依赖图不变时

- `Get-DependencyHandoffPlan` 返回 `unchanged`：不创建 `D:\beian-deps`、不执行 `npm`、不改变任何日志文本（第 237、1356 行文案保留），journal 新字段为空、`dependency_mutated=false`。
- 恢复脚本在 `dependency_mutated=false` 时完全跳过新逻辑。
- 唯一额外动作：清理遗留 `stage-*`（若存在）。这是停服前、失败只告警的操作。

---

## 11. 合同与文档更新

| 文件 | 位置 | 更新内容 |
|---|---|---|
| `scripts/windows/README.md` | 第 87 行（步骤 1） | 补充：依赖图变化时在 `D:\beian-deps\stage-<sha>` 停服前构建并断网验证；这是唯一联网安装点 |
| 同上 | 第 93 行（步骤 5） | 「再次证明该目标的依赖图未变」改为「依赖未变则复用；变化则原子换入已验证的 staged node_modules，并对目标树重跑离线探针」 |
| 同上 | 第 94 行（步骤 6） | 恢复先换回 backup node_modules，再恢复 UI、reset、重跑旧探针；「恢复路径不执行 npm/Python 在线安装」保持 |
| 同上 | 第 104 行 | 改写：npm 依赖升级由发版事务的停服前 staging 自动交接；**Python 依赖升级仍需独立运维变更**；停服后仍不访问 npm/PyPI |
| 同上 | 新增小节 | `D:\beian-deps` 布局、保留策略、磁盘要求、Clash/代理说明、junction 注意事项、人工应急步骤（只读诊断，不手工换目录） |
| `docs/contracts/release.md` | 第 26 行 | 「不在停服后在线安装 npm/Python 依赖」保留，并增加「npm 依赖变化在停服前离线验证后原子交接；Python 依赖变化停服前拒绝」 |
| `AGENTS.md` | — | 当前快照中未找到直接引用该规则的行（grep `依赖|npm|离线`无相关命中）；建议不改，或在发版入口处加一行指向 README。若完整仓库中存在引用，需同步 |
| `TESTING.md` | 第 18、27 行 | 增加新静态合同测试与 Windows job 新步骤的说明；强调 Windows job 不调用 `release.ps1`、不触达生产 |
| `.github/workflows/hangzhou-release.yml` | 第 21 行 | `timeout-minutes` 40 → 60（待 Q2）。下载文件列表（第 43 行 `$files`）不变，除非把新逻辑拆为独立文件（不建议：恢复脚本必须自包含） |

---

## 12. 测试计划

仓库没有 Pester；现有测试分三层（TESTING.md）：服务端 L0 静态锁 `apps/web/server/src/windows-release-script.test.ts`、`quality.yml` 的 GitHub-hosted `windows-2022` PowerShell 5.1 合同 job（注意：实际是 `windows-2022` 而非 `windows-latest`）、杭州发版 L1。沿用这三层，不引入 Pester（引入需另行批准依赖）。

### 12.1 Mac / L0（`npm test`）

- `windows-release-script.test.ts` 新增静态断言：
  - `release.ps1` 中 `npm ci` 只出现在停服前函数内，且在 `Stop-BeianWinSwService` 调用位置之前（按源码顺序/函数调用图断言）；
  - 停服后代码段不出现 `npm ci|npm install|pip install`；
  - `dependency_mutated = $true` 的赋值出现在第一个 `Directory]::Move` 之前，且紧跟 `Set-ReleaseJournalStage "deps_swap"`；
  - `release-recover.ps1` 中 `Restore-DependencyBackup` 位于 `Stop-BeianService` 之后、`reset --hard` 之前；
  - 删除 node_modules 的路径都经过「先拆 junction」的辅助函数；
  - 恢复脚本不 dot-source 任何 checkout 内模块（自包含）。
- `release-dependency-check.mjs` 新增 `installed` 子命令的 `node:test` 单测：构造合成隐藏 lock，覆盖一致、缺包、版本不符、`os/cpu` 跳过的可选包、工作区 link 条目。
- 对 0.31 的真实 lock 做一次核对（PR 阶段、Mac 上）：`packages` 中存在 `node_modules/@img/sharp-win32-x64`、`node_modules/@rollup/rollup-win32-x64-msvc`、`node_modules/@esbuild/win32-x64` 条目。

### 12.2 GitHub-hosted `windows-2022` 合同 job（`quality.yml`）

新增一个步骤，在 runner 临时目录里**构造假仓库**（不含生产路径、不调用 `release.ps1`、不注册任何计划任务/服务）：

1. 用 npm 工作区建一个最小 monorepo，`npm ci` 后验证 workspace junction 为绝对路径；执行「重指向 junction」辅助逻辑，再整体 `Directory.Move` 到同卷新位置，断言 `npm ls --offline` 通过、junction 目标正确。
2. 删除辅助函数不会删穿 junction 目标。
3. 打开一个 `node_modules` 内文件句柄时 `Directory.Move` 抛 `IOException` 且源目录完整。
4. 对 7.2 状态表的每一行构造磁盘状态，运行抽出的恢复判定函数（以可单独加载的纯 PowerShell 片段形式在测试中复制，或通过参数化脚本块），断言动作与收敛。注意：恢复脚本必须自包含，测试只能复制/解析，不能让生产脚本依赖公共模块。
5. （可选）在 runner 上实装 `sharp@0.34.4` 并断网（设置无效代理 + `npm_config_offline`）执行 `require('sharp')` + metadata，验证探针脚本本身正确。

### 12.3 杭州 L1

- 本修复本身就会在第一次 npm 依赖变化发版（0.31.0.0）时完整走一遍 staging → swap → 冒烟。L1 证据：Actions 日志中的 stage 指纹、`dependency graph changed; swapped ...`、`SMOKE ok version=0.31.0.0`。
- 回滚路径无法在生产上主动演练（禁止故意制造失败）。依赖 12.2 的合成测试 + 代码审查。是否需要在 Windows 测试机（非生产）上做一次端到端演练，见 Q8。

---

## 13. 0.31.0.0 上线计划

1. **PR**：实现本设计（release.ps1、release-recover.ps1、release-dependency-check.mjs、文档、测试、workflow 超时）。CI：Linux 质量 job + `windows-2022` 合同 job 全绿；`/ship` L0 全绿。
2. **合入前核对**：0.31 lock 含 win32 平台包条目（12.1）；杭州 `D:` 可用空间 ≥ 约 3–4 GB（需用户/运维只读确认，见 Q1）。
3. **合入 main**：此 push 的 SHA 同时包含 `5a9d79d` 的 sharp 变更与本修复。`hangzhou-release` 为该 SHA 下载**新** `release.ps1`。
4. **已排队的 `5a9d79d` run**：它绑定旧 `release.ps1`，会在停服前再次以同样错误失败（安全，8787 不受影响）；由于 `concurrency` 串行，它先失败，然后新 run 执行。也可由用户在 Actions 中手动取消该 run（不影响生产，但属于外部操作，需用户决定）。
5. **新 run**：pre = 0.30.3.3，target = 包含修复的 0.31.0.0（VERSION 若随修复改为 0.31.0.1 等以实际为准）。预计日志：staging 构建、P1–P8 通过、drain、停服、merge、换位、目标探针、UI 构建、冒烟、committed。
6. **上线后**：公网 `/api/health` 版本核对（既有步骤 1455 行）；确认 `D:\beian-deps\backup-eb2ceb8...` 存在；记录 L1 证据到 TODOS/发布记录。
7. **若失败**：停服前失败 → 0.30.3.3 继续在线，看日志修复后再 push；停服后失败 → watchdog 自动恢复到 0.30.3.3 + OLD 依赖。

不允许的捷径：手工在杭州 `npm install`、手工 pull/重启、本地手跑 `release.ps1`、用 `ALLOW_LEGACY_OFFLINE_BOOTSTRAP`（仅限 0.19→0.20）。

---

## 14. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| Mac 生成的 lock 缺 win32 可选包条目 | `npm ci` 后 sharp/rollup 不可加载 | P5/P6/P8 停服前失败；PR 阶段核对 |
| Clash/registry 不稳定 | staging 失败 | 停服前失败，无生产影响；可重跑 |
| `npm ci` 运行 install scripts 带来供应链执行面（以 LocalSystem 运行） | 安全 | 依赖 lock integrity；可选 `--ignore-scripts`（Q3）；staging 在仓库外，探针前不启动服务 |
| junction 处理错误导致删穿源码 | 严重 | 只删 reparse point 本身；白名单；合成测试 12.2-2 |
| 换位时外部进程持有 node_modules 句柄 | 换位失败 | 前置进程检查；失败即恢复（rename 原子） |
| 磁盘不足 | staging 或换位失败 | 停服前空间检查；保留策略 |
| 时间超出 40 分钟 | Actions 中断 | 提升超时；npm ci 15 分钟上限；停服后 watchdog 兜底 |
| `installed` 指纹算法与 npm 隐藏 lock 格式变化（npm 大版本） | 误报失败 | 记录 npm 版本到 stamp；失败在停服前；单测覆盖 |
| sharp 运行时需要 VC++ 运行库 | 加载失败 | P5 真实解码探针在停服前发现 |
| ACL 复制不正确 | 换位后 Agent/运维读不到 | 采用复制 `D:\beian` ACL；换位后探针以 SYSTEM 运行，Agent 读权限需 Q5 确认 |

---

## 15. 开放问题（需要用户决定）

| # | 问题 | 建议默认 |
|---|---|---|
| Q1 | 杭州 `D:` 剩余空间是否 ≥ 4 GB？staging 是否必须在 `D:`（与仓库同卷）——是否接受新建 `D:\beian-deps` 目录？ | 接受 `D:\beian-deps` |
| Q2 | `hangzhou-release.yml` `timeout-minutes` 从 40 提升到 60？ | 60 |
| Q3 | `npm ci` 是否允许 install scripts（以 LocalSystem 执行第三方脚本），还是 `--ignore-scripts` + 探针兜底？ | 允许（sharp/esbuild 需要校验脚本），但仅在 staging 目录 |
| Q4 | committed 后是否保留上一代 backup（占约 0.5–1 GB）？同 SHA 重跑是否允许复用 staging（仍全量重跑探针）？ | 保留 1 代；允许复用但重验 |
| Q5 | Session 1 Illustrator Agent 或其他非 SYSTEM 账号是否需要读取 `node_modules`？`D:\beian` 当前 ACL 是否允许低权限写入？ | 复制仓库 ACL；需运维只读确认 |
| Q6 | 断网验证是否只用代理/registry 指向无效地址，还是在 CD 中临时加 Windows 防火墙规则？ | 只用环境变量，不改防火墙 |
| Q7 | journal 协议号保持 `v1`（新字段可选）还是升级 `v2`？ | 保持 `v1` |
| Q8 | 是否需要一台非生产 Windows 机器做一次端到端（含故意失败回滚）演练，再上 0.31？ | 建议有条件就做；否则依赖 GitHub-hosted 合成测试 |
| Q9 | Python 依赖交接是否立项第二期（版本化 venv）？第一期继续拒绝是否可接受？ | 第一期拒绝，第二期按需立项 |
| Q10 | 已排队的 `5a9d79d` run：任其在停服前自然失败，还是手动取消？ | 任其失败（无生产影响） |

## 附：实施偏差（0.31.1.0）

用户已批准本设计（Q1–Q10）。实现时有以下偏差，以代码为准：

1. **目录布局**：不用 `D:\beian-deps\<sha>\src`，改为 `D:\beian-deps\stage-<SHA前12位>`（源码 + node_modules）与 `work-<SHA前12位>`（npm cache、日志、stamp），备份为 `backup-<旧SHA12>-<UTC>`、目标树隔离为 `failed-<目标SHA12>-<UTC>`。原因：缩短前缀，避免 node_modules 深路径超过 Windows MAX_PATH。
2. **Rollup Windows 原生包**：仓库 lock 由 Mac 生成，缺 `@rollup/rollup-win32-x64-msvc` 条目（npm/cli#4828），干净 `npm ci` 不会安装。staging 在停服前按 rollup `optionalDependencies` 声明的精确版本 `npm pack` 后解包到 rollup 旁；`installed` 校验仍只对 lock。
3. **`installed` 校验**：缺失条目仅在「OS/CPU 不适用」或「optional 且没有已安装包请求它」时放行（例如 `@img/sharp-wasm32 → @emnapi/runtime → tslib`）。
4. **恢复时旧树核对**：不对旧树做 `installed == 旧指纹`（生产旧树是手工预置的，未必与 lock 逐项一致），改为停服前记录根 `node_modules\.package-lock.json` 的 SHA256（`deps_old_tree_marker`），换回后比对，再跑原有离线探针。
5. **Vite 位置**：干净 `npm ci` 把 Vite 放在 `apps\web\ui\node_modules`；`release.ps1` 与 `release-recover.ps1` 的冷启动探针同时接受根目录与 UI workspace 两处。
6. **停服前失败的 stage**：保留同 SHA 的 stage 供下次复用（探针全部重跑）；其他 SHA 的 stage/work 在下次 staged 发版时清理。依赖图不变的发版完全不触碰 `D:\beian-deps`。
