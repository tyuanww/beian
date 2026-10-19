# How to 在本机打开开发页

在自己的电脑上打开审稿台开发页。不登录杭州，不改 DNS，不发版。

## 前置条件

- Node.js 20 或更高。在仓库根目录执行命令。
- 本机 5173 没有被别的程序占用。被占用时启动会失败，脚本不会改去别的端口。
- 产品入口是 http://127.0.0.1:8787/ 。开发页是 http://127.0.0.1:5173/ ，`/api` 与 `/favicon.ico` 转到 8787（避免非 HTML 页首访时 Vite 对 favicon 404）。

## 步骤

1. 安装依赖。根目录已有 `node_modules` 时可以跳过。

   ```bash
   node -v
   npm install
   ```

   `npm install` 会装上已审核的 `@ant-design/cli@6.6.1`。组件查询只用这一份，不用 PATH 上的其他 `antd`。

2. 启动。

   ```bash
   ./scripts/dev-start.sh
   ```

   8787 已经在跑、只改界面时，改用 `npm run dev:ui`。

3. 浏览器打开 http://127.0.0.1:5173/ 。未登录会去飞书。授权失败回到飞书重试，不要把远程验收人指到这台电脑。

## 验证

开发页能打开。终端没有「端口占用」失败。查一个组件：

```bash
node scripts/quality/antd-readonly.mjs info Button --lang zh --format json
```

退出码是 0，stdout 是 JSON。参数看不懂时：

```bash
node scripts/quality/antd-readonly.mjs --help
```

## 常见失败

- 5173 已被占用。先看是谁占用，停掉那个进程后再启动。不要为这个仓库再开一个入口。
- 5173 登录闪一下，或 `/api` 返回 HTML、空 Content-Type。打开 http://127.0.0.1:8787/ 。JSON 404 是接口说没有这条记录，不是开发页没转到 8787。
- 组件查询退出码 2，stderr 有 `code: ANTD_CLI_VERSION` 或 `code: ANTD_CLI_MISSING`。按 stderr 的「下一步」在仓库根运行 `npm install`。不要改全局 `antd`。升级 CLI 要单独批准。
- 界面测试用 `npm run test -w beian-ui`。类型和构建用仓库根的 `npm run typecheck`。不要在 `apps/web/ui` 里直接跑 `npx tsc`。

按钮、打样白底和 44px 点击区见 [界面约束](contracts/interface.md)。测试范围见 [TESTING.md](../TESTING.md)。提缺陷用仓库里的 [缺陷模板](../.github/ISSUE_TEMPLATE/bug.yml)。
