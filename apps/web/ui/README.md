# beian UI（React + TypeScript + Ant Design 6）

审稿台（任务 / 新建 / 审核）、打样台、文件压缩、历史记录、设置（开工板 + 费用账单）。对照 / 对红 / 打样 / 压缩排队时用等待卡，不要假取消。离开后再进看板、打样台、文件压缩详情或历史记录，卡片、侧栏圆点和历史行仍显示阶段；点进行中的审稿进等待卡，打样进打样单，压缩进压缩详情。核对页有 bbox 才画真框，钉在框中心；「显示钉」和「显示框」分开，拖动画布时框暂时藏。初始 1× 页图不施加恒等 transform，避免高清 SVG 首屏被提前栅格化。核对栏固定在工作区右侧，宽 320px、不能调宽、可收起并独立滚动。电脑端工具栏「就地对照」默认开：只画当前这一条的段落框和错点框，对照贴在框旁；关掉后详情回到右栏。手机不显示开关，也不使用已保存的开。疑点目录与待确认导航置顶。疑点列表置顶；当前字段先 16px 嘱咐再结论下拉，Excel 应印与稿上读到两列。结论写在页头。打样台和打样单分开，点进度进打样单。有地面图的新单仍是一屏三列成片（不要上 1 下 2），预览和下载同一合成器，页头藏「下载 PPT」，灯光收到「调灯」后面；没有地面图的旧单仍是一屏三图看形、白底有描边、页头「下载 PPT」（没写成仍显示，点了出「PPT 没写成，白底仍可下」）。缺印刷面可补切。下面印刷面读字；产品/背景灯光分开调；打样中和失败可重试。唯一「上刀线」默认黑盒提交，失败对籽烨结案为打样失败，选层只给 admin。唯一可确认正面服务端自动出图；多面时桌面待选正面把展开图、选项、错误和主动作收在一屏。管理员可在已出图且只有一套公开盒型的单上换正面。打样台和打样单主区白底深字；每张图右上角下载；不提供成片 PDF 下载入口，独立净版展开 PDF 仍可按原尺寸下载；点下载底部提示不挡操作；GLB 全屏居中；截图时下载钮藏起来；全屏被拒出「全屏打不开」；GLB 中性环境。文件压缩支持批量图片/PDF、逐文件状态、自动目标大小、预览和结果下载。地址：`/reviewup` `/reviewup/new` `/review/:id` `/mockup` `/mockup/new` `/mockup/:id` `/compress` `/compress/:id` `/history` `/settings`，后退换台。旧 `/` `/new` `/review` 转到新地址。没有自建登录页：未登录会跳飞书授权。

飞书身份、`/api/tasks`、`/api/settings`、`/api/mockups` 已接线。核对页包装图用 CSS transform 缩放（1–6×）并 rAF 拖动，不上 OpenSeadragon；只有非初始缩放/平移才输出 transform，`will-change` 只在实际平移时短暂启用。打样单读字区同样走 `canvasZoom.ts` 1–6×；白底静帧不拿来读字。

```bash
cd apps/web/ui
npm install
npm run dev
```

浏览器：http://127.0.0.1:5173/（Vite 听本机网卡，端口占用即失败）  
`/api` 代理到 TypeScript 服务 `127.0.0.1:8787`（`apps/web/server`，不是 FastAPI）。5173 登录闪或 `/api` 返回 HTML / 空 Content-Type：打开 http://127.0.0.1:8787/。飞书授权失败再走飞书，不要把远程验收人指到本机。JSON 404 不是代理挂了。

组件查询只从仓库根目录走已审核的只读包装器；不要直接运行 `antd` CLI：

```bash
node scripts/quality/antd-readonly.mjs info Button --lang zh --format json
node scripts/quality/antd-readonly.mjs demo Upload drag --format json
```
