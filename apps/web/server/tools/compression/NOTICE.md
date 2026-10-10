# 压缩工具许可

本目录的 `contain.py`、`image-worker.mjs` 和 `PdfCompress.java` 是 beian 自己的代码。

第三方运行时不随仓库分发，版本和许可固定如下：

| 组件 | 版本 | 许可 | 来源 |
|---|---|---|---|
| sharp | 0.34.4 | Apache-2.0 | https://github.com/lovell/sharp |
| sharp 附带的 libvips | 随 sharp 0.34.4 预编译包 | LGPL-3.0 | https://github.com/libvips/libvips |
| qpdf | **12.4.2**（运行机 PATH 必须报告 `qpdf version 12.4.2`，不内置二进制） | Apache-2.0 | https://github.com/qpdf/qpdf/tree/v12.4.2 |
| Apache PDFBox | 3.0.5，`pdfbox-app` | Apache-2.0 | https://pdfbox.apache.org/ |
| JDK | 能执行 `java --source 17` 的本机 JDK | 由发行版声明 | 不内置 |

PDFBox 的 jar 放在环境变量 `BEIAN_PDFBOX_JAR`，或本目录的 `pdfbox.jar`（已忽略，不提交）。Maven 坐标是 `org.apache.pdfbox:pdfbox-app:3.0.5`。

PDF 体积迭代只借鉴 Stirling-PDF 里许可为 MIT 的 `app/core` 目标大小思路：先做 qpdf 无损结构优化，再从原件按质量从高到低生成有限候选，第一份合格且小于 10,000,000 字节就停止。这里没有复制 Stirling 源码，也不部署 Stirling 站点、商业 engine 或第三方服务。

Hono 进程不加载 sharp，也不解码图片。图片由 `image-worker.mjs` 在独立进程里处理。qpdf 与 Java helper 都经过 `contain.py`，且命令行不使用 shell。不能设置驻留内存上限时，helper 不会启动。
