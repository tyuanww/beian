import { api, ApiError, studioDownloadCollection } from "../api";
import type { BackdropPreset } from "./mockupStudio";
import { studioGenerationParam } from "./mockupStudioVersion";

export type StudioShotKey = "white_a" | "white_b";
export type StudioDownloadLayer = "none" | "ground" | "set" | "auto";
export type PaintedStudioBackground = {
  backdrop: BackdropPreset;
  layer: Exclude<StudioDownloadLayer, "auto">;
};

export function studioDownloadLayer(
  backdrop: BackdropPreset, painted: PaintedStudioBackground | null,
): StudioDownloadLayer {
  if (backdrop !== "white_set") return "none";
  return painted?.backdrop === backdrop ? painted.layer : "auto";
}

export type StudioDownloadView = {
  generation: string;
  fileKey: StudioShotKey;
  backdrop: BackdropPreset;
  productLight: number;
  backgroundLight: number;
};
export type StudioDownloadSelection = StudioDownloadView & { layer: StudioDownloadLayer };
export type StudioDownloadBody = {
  file_key: StudioShotKey;
  generation_id?: string;
  generation?: string;
  backdrop: BackdropPreset;
  layer: StudioDownloadLayer;
  product_light: number;
  background_light: number;
};

export function studioDownloadBody(selection: StudioDownloadSelection): StudioDownloadBody {
  const { generation, fileKey, backdrop, layer, productLight, backgroundLight } = selection;
  return {
    file_key: fileKey,
    ...(generation ? { [studioGenerationParam(generation)]: generation } : {}),
    backdrop, layer, product_light: productLight, background_light: backgroundLight,
  };
}

type DownloadEntry = {
  id: string;
  selection: StudioDownloadSelection;
  createdAt: string;
};
type ReadyDownload = DownloadEntry & { kind: "ready"; href: string; handedOff: boolean };
export type StudioDownloadEntry = ReadyDownload | (DownloadEntry & { kind: "preparing" | "failed" | "unreachable" | "capacity" });
type DownloadSnapshot = { entries: readonly StudioDownloadEntry[]; preparing: boolean };

function parseRecord(jobId: string, value: unknown): StudioDownloadEntry {
  if (!value || typeof value !== "object") throw new Error("成片记录无效");
  const { id, status, created_at, file_key, generation, backdrop, layer, product_light, background_light, download_url }: Record<string, unknown> =
    Object.fromEntries(Object.entries(value));
  if (typeof id !== "string" || !/^[a-z0-9_-]+$/i.test(id) || typeof created_at !== "string" || typeof generation !== "string"
    || (file_key !== "white_a" && file_key !== "white_b")
    || (backdrop !== "white" && backdrop !== "silver" && backdrop !== "white_set")
    || (layer !== "none" && layer !== "ground" && layer !== "set" && layer !== "auto")
    || typeof product_light !== "number" || typeof background_light !== "number") {
    throw new Error("成片记录无效");
  }
  const entry: DownloadEntry = {
    id, createdAt: created_at,
    selection: { generation, fileKey: file_key, backdrop, layer, productLight: product_light, backgroundLight: background_light },
  };
  if (status === "ready" && download_url === `${studioDownloadCollection(jobId)}/${encodeURIComponent(id)}/file`) {
    return { ...entry, kind: "ready", href: download_url, handedOff: false };
  }
  if (status === "preparing" || status === "failed") return { ...entry, kind: status };
  throw new Error("成片记录无效");
}

function parseCollection(jobId: string, value: unknown): StudioDownloadEntry[] {
  if (!value || typeof value !== "object" || !("items" in value) || !Array.isArray(value.items)) {
    throw new Error("成片记录无效");
  }
  return value.items.map((item: unknown) => parseRecord(jobId, item));
}

function viewKey({ generation, fileKey, backdrop, productLight, backgroundLight }: StudioDownloadView): string {
  return JSON.stringify([generation, fileKey, backdrop, productLight, backgroundLight]);
}

function selectionKey(selection: StudioDownloadSelection): string {
  return `${viewKey(selection)}:${selection.layer}`;
}

export function studioDownloadFor(entries: readonly StudioDownloadEntry[], view: StudioDownloadView): StudioDownloadEntry | undefined {
  const key = viewKey(view);
  return entries.find(entry => viewKey(entry.selection) === key);
}

const POLL_MS = 1_000;
const MAX_READ_FAILURES = 3;
const EMPTY: DownloadSnapshot = { entries: [], preparing: false };
const LOCAL_PREFIX = "local:";

type JobDownloads = {
  snapshot: DownloadSnapshot;
  watched: number;
  loaded: boolean;
  readFailures: number;
  poll: AbortController | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  submissions: Map<string, AbortController>;
  handoffs: Set<string>;
};

function downloadThroughBrowser(href: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = "";
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
  }
}

type StudioDownloadTransport = {
  list: (jobId: string, signal: AbortSignal) => Promise<unknown>;
  prepare: (jobId: string, selection: StudioDownloadBody, signal: AbortSignal) => Promise<unknown>;
  download: (href: string) => void;
};

export function createStudioDownloadStore(transport: StudioDownloadTransport) {
  let owner: string | null = null;
  let handoffEpoch = 0;
  const jobs = new Map<string, JobDownloads>();
  const listeners = new Set<() => void>();

  function notify() {
    for (const listener of listeners) listener();
  }

  function getJob(jobId: string): JobDownloads {
    const existing = jobs.get(jobId);
    if (existing) return existing;
    const job: JobDownloads = {
      snapshot: EMPTY, watched: 0, loaded: false, readFailures: 0,
      poll: null, timer: undefined, submissions: new Map(), handoffs: new Set(),
    };
    jobs.set(jobId, job);
    return job;
  }

  function update(job: JobDownloads, entries = job.snapshot.entries) {
    job.snapshot = {
      entries,
      preparing: job.submissions.size > 0 || (job.handoffs.size > 0 && job.readFailures === 0),
    };
    notify();
  }

  function stopRead(job: JobDownloads) {
    clearTimeout(job.timer);
    job.timer = undefined;
    job.poll?.abort();
    job.poll = null;
  }

  function dropJob(jobId: string, job: JobDownloads) {
    stopRead(job);
    for (const controller of job.submissions.values()) controller.abort();
    jobs.delete(jobId);
  }

  function settleIdleJob(jobId: string, job: JobDownloads): boolean {
    const idle = !job.watched && !job.handoffs.size && !job.submissions.size;
    if (idle) dropJob(jobId, job);
    return idle;
  }

  function handoff(entry: ReadyDownload): ReadyDownload {
    transport.download(entry.href);
    return { ...entry, handedOff: true };
  }

  function mergeRecords(job: JobDownloads, records: StudioDownloadEntry[]): StudioDownloadEntry[] {
    const previous = new Map(job.snapshot.entries.map(entry => [entry.id, entry]));
    const received = new Set(records.map(entry => entry.id));
    const selected = new Set(records.map(entry => selectionKey(entry.selection)));
    const localFailures = job.snapshot.entries.filter(entry =>
      (entry.kind === "failed" || entry.kind === "capacity")
      && entry.id.startsWith(LOCAL_PREFIX) && !selected.has(selectionKey(entry.selection)));
    const missing = job.snapshot.entries.flatMap(entry =>
      entry.kind === "preparing" && !received.has(entry.id) && job.handoffs.has(entry.id)
        ? [{ ...entry, kind: "failed" as const, id: `${LOCAL_PREFIX}${selectionKey(entry.selection)}` }]
        : []);
    for (const id of job.handoffs) if (!received.has(id)) job.handoffs.delete(id);
    return [...localFailures, ...missing, ...records.map(entry => {
      if (entry.kind === "ready" && job.handoffs.delete(entry.id)) return handoff(entry);
      if (entry.kind === "failed") job.handoffs.delete(entry.id);
      const prior = previous.get(entry.id);
      return entry.kind === "ready" && prior?.kind === "ready" && prior.handedOff
        ? { ...entry, handedOff: true }
        : entry;
    })].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function scheduleRead(jobId: string, job: JobDownloads, delay: number) {
    if (settleIdleJob(jobId, job) || job.poll || job.timer !== undefined || job.submissions.size) return;
    if (job.loaded && !job.snapshot.entries.some(entry => entry.kind === "preparing")) return;
    job.timer = setTimeout(() => {
      job.timer = undefined;
      void refresh(jobId, job);
    }, delay);
  }

  async function refresh(jobId: string, job: JobDownloads) {
    const read = new AbortController();
    job.poll = read;
    try {
      const value = await transport.list(jobId, read.signal);
      if (read.signal.aborted || jobs.get(jobId) !== job) return;
      const entries = mergeRecords(job, parseCollection(jobId, value));
      job.loaded = true;
      job.readFailures = 0;
      update(job, entries);
    } catch (error) {
      if (read.signal.aborted || jobs.get(jobId) !== job) return;
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        dropJob(jobId, job);
        notify();
        return;
      }
      job.readFailures += 1;
      if (job.readFailures < MAX_READ_FAILURES) {
        update(job);
      } else {
        job.handoffs.clear();
        job.loaded = true;
        update(job, job.snapshot.entries.map(entry => entry.kind === "preparing" ? { ...entry, kind: "unreachable" } : entry));
      }
    } finally {
      if (job.poll === read) {
        job.poll = null;
        scheduleRead(jobId, job, POLL_MS * 2 ** Math.min(job.readFailures, 3));
      }
    }
  }

  async function start(jobId: string, actor: string, selection: StudioDownloadSelection) {
    if (!owner || actor !== owner) return;
    const job = getJob(jobId);
    const key = selectionKey(selection);
    const existing = job.snapshot.entries.find(entry => selectionKey(entry.selection) === key);
    if (job.submissions.has(key) || existing?.kind === "preparing") return;

    stopRead(job);
    job.readFailures = 0;
    const post = new AbortController();
    const requestedHandoff = handoffEpoch;
    job.submissions.set(key, post);
    const local: StudioDownloadEntry = {
      id: `${LOCAL_PREFIX}${key}`, kind: "preparing", selection, createdAt: new Date().toISOString(),
    };
    const otherEntries = () => job.snapshot.entries.filter(entry => selectionKey(entry.selection) !== key);
    update(job, [local, ...otherEntries()]);
    try {
      const entry = parseRecord(jobId, await transport.prepare(jobId, studioDownloadBody(selection), post.signal));
      if (post.signal.aborted || jobs.get(jobId) !== job) return;
      const canHandoff = handoffEpoch === requestedHandoff;
      if (entry.kind === "preparing" && canHandoff) job.handoffs.add(entry.id);
      const result = entry.kind === "ready" && canHandoff ? handoff(entry) : entry;
      update(job, [result, ...otherEntries().filter(item => item.id !== entry.id)]);
    } catch (error) {
      if (post.signal.aborted || jobs.get(jobId) !== job) return;
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        dropJob(jobId, job);
        notify();
      } else {
        job.loaded = false;
        const kind = error instanceof ApiError && error.reason === "studio_download_capacity" ? "capacity" : "failed";
        update(job, [{ ...local, kind }, ...otherEntries()]);
      }
    } finally {
      if (jobs.get(jobId) === job) {
        job.submissions.delete(key);
        update(job);
        scheduleRead(jobId, job, POLL_MS);
      }
    }
  }

  return {
    setOwner(actor: string | null) {
      if (owner === actor) return;
      owner = actor;
      for (const [jobId, job] of jobs) dropJob(jobId, job);
      notify();
    },
    abandonHandoffs() {
      handoffEpoch += 1;
      for (const [jobId, job] of jobs) {
        job.handoffs.clear();
        if (!settleIdleJob(jobId, job)) update(job);
      }
    },
    watch(jobId: string, actor: string) {
      if (!owner || actor !== owner) return () => undefined;
      const job = getJob(jobId);
      job.watched += 1;
      scheduleRead(jobId, job, 0);
      return () => {
        job.watched -= 1;
        if (jobs.get(jobId) === job) settleIdleJob(jobId, job);
      };
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    snapshot(jobId: string, actor: string): DownloadSnapshot {
      return owner && actor === owner ? jobs.get(jobId)?.snapshot ?? EMPTY : EMPTY;
    },
    start,
  };
}

export const studioDownloads = createStudioDownloadStore({
  list: api.studioDownloads,
  prepare: api.prepareStudioDownload,
  download: downloadThroughBrowser,
});
