import { createServer } from "node:http";
import { test as base } from "@playwright/test";

type Attachment = { filename: string; body: Buffer };
export type StudioFiles = Map<string, () => Attachment | undefined>;

export const studioDownloadTest = base.extend<{ studioFiles: StudioFiles }>({
  studioFiles: async ({}, use) => { await use(new Map()); },
  baseURL: async ({ studioFiles }, use) => {
    // Chromium's native download goes straight to HTTP, bypassing Playwright routing.
    const server = createServer((request, response) => {
      const file = request.method === "GET" && request.url ? studioFiles.get(request.url)?.() : undefined;
      if (!file) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "Content-Length": file.body.length,
        "Cache-Control": "private, no-store",
      }).end(file.body);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("成片附件测试地址缺失");
      await use(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  },
});
