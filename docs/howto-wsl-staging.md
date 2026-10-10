# 操作指南：杭州机 WSL2 预发副本（staging，非生产）

> **这是预发/演示环境，不是生产，也不属于 [发布合同](contracts/release.md)。** 它的 health、版本和功能表现都不能作为生产发版证据；生产只认杭州 Windows `beian-server-8787` 与 `hangzhou-release` 的可信链。

## 现状（2026-10-10）

| 项 | 值 |
|---|---|
| 宿主 | 杭州机的 WSL2 Ubuntu |
| 访问 | Tailscale `100.93.46.46`，`root` 账号，Mac 上的密钥 `~/.ssh/id_ed25519_pc2` |
| 服务 | systemd `beian-wsl.service`，监听 `127.0.0.1:18787` |
| 代码 / 数据 | `/opt/beian`；数据 `/srv/beian-data`（与生产 `C:\supply\data` 隔离） |
| 公网 | 未开放。计划在现有远程管理隧道 `customer-agent-hangzhou` 上加 `beian-staging.jianghua.site`，尚未添加 |
| 能力限制 | Linux 上没有 Illustrator/Blender，打样/对照不可用；health 中 Illustrator 状态误报“macOS 继续使用现有 AppleScript 桥”（TODOS F08） |

注意：AGENTS 与发布合同禁止 Mac 对话 SSH 进杭州 **Windows 生产**；本副本经 Tailscale 访问 WSL 是单独授权的预发通道。不要借它进入 Windows 宿主、读取 `C:\supply\data` 或操作 8787/cloudflared。

## 常用操作

```bash
ssh -i ~/.ssh/id_ed25519_pc2 root@100.93.46.46
systemctl status beian-wsl.service
journalctl -u beian-wsl.service -n 100 --no-pager
curl -sS http://127.0.0.1:18787/api/health
```

### 更新到某个 main SHA

```bash
cd /opt/beian
git fetch origin && git checkout --detach <sha>
npm ci --include=dev --include=optional
# lock 由 Mac 生成，缺 Linux Rollup 原生包（npm/cli#4828，TODOS F07）
v=$(node -p "require('./apps/web/ui/node_modules/rollup/package.json').version")
npm install --prefix apps/web/ui --no-save --package-lock=false --ignore-scripts "@rollup/rollup-linux-x64-gnu@$v"
npm run build -w beian-ui
systemctl restart beian-wsl.service
curl -sS http://127.0.0.1:18787/api/health
```

Python 后端依赖变化时，在副本自己的 venv 中按 `apps/web/backend/requirements.txt` 安装；不要复制 Windows 的 `.venv`。

## 边界

- 数据只用合成或已获许可的样本；真实稿与客户数据不进 `/srv/beian-data`，除非另获许可。
- 加公网主机名前：先修 F08 的 health 文案、确认登录要求（不得用显示名裸登录），并取得 DNS/隧道变更授权。
- 本副本出错不影响也不证明生产；不要据此跳过 `quality` 或 `hangzhou-release`。
