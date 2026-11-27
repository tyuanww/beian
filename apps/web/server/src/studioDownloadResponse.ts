import { createReadStream, read } from "node:fs";
import { Readable } from "node:stream";
import type { openStudioDownload } from "./studioDownloads.js";

type ByteRange = { start: number; end: number };

function byteRange(value: string, size: number): ByteRange | null | undefined {
  // Range units other than bytes, malformed syntax and multipart requests can
  // be served as a full response. A valid single range can be unsatisfiable.
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return suffix ? { start: Math.max(0, size - suffix), end: size - 1 } : null;
  }
  const start = Number(match[1]);
  const last = match[2] ? Number(match[2]) : size - 1;
  if (start >= size || last < start) return null;
  return { start, end: Math.min(size - 1, last) };
}

export function studioDownloadFileResponse(request: Request, file: ReturnType<typeof openStudioDownload>): Response {
  const etag = `"sha256-${file.sha256}"`;
  try {
    const ascii = file.name.replace(/[^\x20-\x7e]|"/g, "_");
    const encoded = encodeURIComponent(file.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const headers = new Headers({
      ETag: etag,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "Content-Type": "image/png",
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") {
      file.close();
      headers.set("Content-Length", String(file.bytes));
      return new Response(null, { headers });
    }
    const range = request.headers.get("range");
    const ifRange = request.headers.get("if-range");
    const partial = range && (ifRange === null || ifRange === etag) ? byteRange(range, file.bytes) : undefined;
    if (partial === null) {
      file.close();
      headers.set("Content-Range", `bytes */${file.bytes}`);
      headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }
    const { start, end } = partial ?? { start: 0, end: file.bytes - 1 };
    headers.set("Content-Length", String(end - start + 1));
    if (partial) headers.set("Content-Range", `bytes ${start}-${end}/${file.bytes}`);
    const stream = createReadStream("", {
      fd: file.fd, autoClose: true, start, end,
      fs: { read, close: (_fd, callback) => {
        try { file.close(); callback(null); }
        catch (error) { callback(error instanceof Error ? error : new Error("Closing studio download failed")); }
      } },
    });
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: partial ? 206 : 200, headers });
  } catch (error) { file.close(); throw error; }
}
