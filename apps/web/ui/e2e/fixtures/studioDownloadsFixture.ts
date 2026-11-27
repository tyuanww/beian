import { createHash } from "node:crypto";
import type { Route } from "@playwright/test";
import type { StudioDownloadBody } from "../../src/pages/mockupStillDownload";
import type { StudioFiles } from "./nativeStudioFiles";

export type StudioSelection = StudioDownloadBody;
export type StudioPreparation = "ready" | "reject" | { promise: Promise<void>; failed?: true };

type StudioRecord = {
  id: string;
  status: "preparing" | "ready" | "failed";
  created_at: string;
  selection: StudioSelection;
};

function isStudioSelection(input: unknown): input is StudioSelection {
  return typeof input === "object" && input !== null
    && "file_key" in input && (input.file_key === "white_a" || input.file_key === "white_b")
    && (!("generation_id" in input) || typeof input.generation_id === "string")
    && (!("generation" in input) || typeof input.generation === "string")
    && "backdrop" in input && (input.backdrop === "white" || input.backdrop === "silver" || input.backdrop === "white_set")
    && "layer" in input && (input.layer === "auto" || input.layer === "none" || input.layer === "ground" || input.layer === "set")
    && "product_light" in input && typeof input.product_light === "number"
    && "background_light" in input && typeof input.background_light === "number";
}

export function studioDownloadsFixture(options: {
  jobId: string;
  files: StudioFiles;
  png: (selection: StudioSelection) => Buffer;
  prepare?: (selection: StudioSelection) => StudioPreparation;
  filename?: (fileKey: StudioSelection["file_key"]) => string;
}) {
  const base = `/api/mockups/${options.jobId}/studio-downloads`;
  const requests: unknown[] = [];
  const fileRequests: string[] = [];
  const records = new Map<string, StudioRecord>();
  const fileHref = (id: string) => `${base}/${id}/file`;

  function publicRecord({ id, status, created_at, selection }: StudioRecord) {
    const { generation_id, generation, ...settings } = selection;
    return {
      id, status, created_at, ...settings,
      generation: generation_id ?? generation ?? "",
      ...(status === "ready" ? { download_url: fileHref(id) } : {}),
    };
  }

  async function handle(route: Route) {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const json = (body: unknown, status: number) => route.fulfill({ status, json: body });
    if (path === base && method === "GET") {
      return json({ items: [...records.values()].reverse().map(publicRecord) }, 200);
    }
    if (path === base && method === "POST") {
      const input: unknown = request.postDataJSON();
      requests.push(input);
      if (!isStudioSelection(input)) return json({ message: "invalid studio selection" }, 400);
      const id = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const current = records.get(id);
      if (current && current.status !== "failed") {
        return json(publicRecord(current), current.status === "preparing" ? 202 : 200);
      }
      const plan = options.prepare?.(input) ?? "ready";
      if (plan === "reject") return json({ message: "missing composition" }, 404);
      const record: StudioRecord = {
        id, selection: input, created_at: "2026-11-27T00:00:00.000Z",
        status: plan === "ready" ? "ready" : "preparing",
      };
      records.set(id, record);
      const href = fileHref(id);
      options.files.set(href, () => {
        fileRequests.push(href);
        const saved = records.get(id);
        if (saved?.status !== "ready") return undefined;
        const key = saved.selection.file_key;
        const filename = options.filename?.(key) ?? `${key}.png`;
        return { filename, body: options.png(saved.selection) };
      });
      if (plan !== "ready") {
        void plan.promise.then(() => {
          records.set(id, { ...record, status: plan.failed ? "failed" : "ready" });
        });
      }
      return json(publicRecord(record), record.status === "preparing" ? 202 : 200);
    }
    if (method === "GET" && options.files.has(path)) return route.continue();
    return json({ message: "studio download unavailable" }, 404);
  }

  return {
    requests, fileRequests, handle,
    matches: (path: string) => path === base || path.startsWith(`${base}/`),
  };
}
