import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { api, brokenApiMessage, type Me } from "./api";
import { authFailureAction, feishuLoginHref, shouldAutoRedirectToFeishu } from "./authGate";
import { Sidebar, type NavKey } from "./chrome/Sidebar";
import { isAdmin } from "./authRole";
import { hrefOf, parsePath, type AppRoute, type AppView } from "./appRoute";
import { liveNavPulse } from "./pages/waitCard";
import { useAppearance } from "./chrome/AppearanceRoot";
import { NewTaskPage } from "./pages/NewTaskPage";
import { ReviewPage } from "./pages/ReviewPage";
import { TasksPage } from "./pages/TasksPage";
import { uploadStore } from "./uploadStore";

const HistoryPage = lazy(() =>
  import("./pages/HistoryPage").then((m) => ({ default: m.HistoryPage })),
);
const MockupDesk = lazy(() =>
  import("./pages/MockupPage").then((m) => ({ default: m.MockupDesk })),
);
const CompressionPage = lazy(() => import("./pages/CompressionPage").then(m => ({ default: m.CompressionPage })));
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);

function PaneFallback({ label }: { label: string }) {
  return <p className="boot">{label}</p>;
}

type View = AppView;

const AUTH_HINT = "wb_login_hint";
const SIDEBAR_KEY = "wb_sidebar";
const AUTH_FALLBACK: Record<string, string> = {
  denied: "已取消飞书授权。",
  expired: "登录已过期，请再点一次。",
  forbidden: "只允许伸美公司的飞书号进入。",
  failed: "飞书授权失败，请再试一次。",
};

function readAuthHint(): string {
  const raw = document.cookie.split(";").map((s) => s.trim());
  const hit = raw.find((s) => s.startsWith(`${AUTH_HINT}=`));
  if (!hit) return "";
  const val = decodeURIComponent(hit.slice(AUTH_HINT.length + 1));
  document.cookie = `${AUTH_HINT}=; Path=/; Max-Age=0`;
  return val;
}

function authTitle(message: string): string {
  if (message.includes("伸美") || message.includes("不允许")) return "进不了这间审稿室";
  if (message.includes("取消")) return "授权未完成";
  if (message.includes("过期")) return "登录已过期";
  return "飞书授权未完成";
}

function AuthShell({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="auth-result">
      <img className="auth-result-logo" src="/brand/shine-mage.png" alt="SHINE MAGE" />
      {title ? <h1 className="auth-result-title">{title}</h1> : null}
      {children}
    </div>
  );
}

function navOf(view: View): NavKey {
  if (view === "mockup" || view === "mockupNew") return "mockup";
  if (view === "compression") return "compression";
  if (view === "history") return "history";
  if (view === "settings") return "settings";
  return "review";
}

const TASK_DEEPLINK = /^[0-9a-f]{12}$/i;
const TASK_STASH = "wb_open_task";
const MOCK_STASH = "wb_open_mockup";

function stashTid(key: string, tid: string) {
  try {
    sessionStorage.setItem(key, tid);
  } catch {
    /* ignore */
  }
}

function takeStashedTid(key: string): string | null {
  try {
    const raw = sessionStorage.getItem(key) || "";
    if (!TASK_DEEPLINK.test(raw)) return null;
    sessionStorage.removeItem(key);
    return raw.toLowerCase();
  } catch {
    return null;
  }
}

function readCollapsed() {
  if (window.matchMedia("(max-width: 1024px)").matches) return true;
  try {
    const raw = localStorage.getItem(SIDEBAR_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    /* fall through to viewport */
  }
  return window.matchMedia("(max-width: 1024px)").matches;
}

function bootRoute() {
  if (typeof window === "undefined") {
    return {
      view: "tasks" as View,
      taskId: null as string | null,
      mockupId: null as string | null,
      compressionId: null as string | null,
      receipt: null as string | null,
    };
  }
  const r = parsePath(window.location.pathname, window.location.search, window.location.hash);
  return { view: r.view, compressionId: r.compressionId ?? null, taskId: r.taskId ?? null, mockupId: r.mockupId ?? null, receipt: r.receipt ?? null };
}

export function App() {
  const { setActor } = useAppearance();
  const [me, setMe] = useState<Me | null>(null);
  const boot = bootRoute();
  const [view, setView] = useState<View>(boot.view);
  const [authError, setAuthError] = useState<string | null>(null);
  const [apiBroken, setApiBroken] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(boot.taskId);
  const [compressionId, setCompressionId] = useState<string | null>(boot.compressionId);
  const [mockupId, setMockupId] = useState<string | null>(boot.mockupId);
  const [receiptId, setReceiptId] = useState<string | null>(boot.receipt);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [livePulse, setLivePulse] = useState({ review: false, mockup: false });
  const [version, setVersion] = useState<string | null>(null);

  const refreshMe = useCallback(async () => {
    try {
      const next = await api.me();
      setMe(next);
      setApiBroken(null);
      if (next.logged_in) {
        uploadStore.setOwner(next.open_id || next.display_name || null);
        if (next.open_id) setActor(next.open_id);
        const r = parsePath(window.location.pathname, window.location.search, window.location.hash);
        setView((cur) => (cur === "tasks" && r.view === "settings" ? "settings" : cur));
        setAuthError(null);
      } else {
        uploadStore.setOwner(null);
        setTaskId(null);
      }
    } catch (e) {
      uploadStore.setOwner(null);
      setApiBroken(brokenApiMessage(e, window.location.host));
      setMe({ logged_in: false, display_name: null, avatar_url: null, role: null, perms: [] });
    }
  }, [setActor]);

  useEffect(() => {
    const err = new URLSearchParams(window.location.search).get("feishu_error") || "";
    const boot = parsePath(window.location.pathname, window.location.search, window.location.hash);
    if (boot.taskId) stashTid(TASK_STASH, boot.taskId);
    if (boot.mockupId) stashTid(MOCK_STASH, boot.mockupId);
    if (err) {
      setAuthError(readAuthHint() || AUTH_FALLBACK[err] || "飞书授权未完成。");
      const url = new URL(window.location.href);
      url.searchParams.delete("feishu_error");
      window.history.replaceState({}, "", url.pathname + url.search);
    }
    void refreshMe();
    // 只在进站时拉一次登录态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onPageHide = () => uploadStore.abortAll();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      uploadStore.abortAll();
    };
  }, []);

  const loggedIn = Boolean(me?.logged_in);

  useEffect(() => {
    if (!loggedIn) return;
    let cancelled = false;
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void api
        .status()
        .then((h) => {
          if (cancelled) return;
          const next = liveNavPulse(h);
          setVersion(h.version || null);
          setLivePulse((cur) => (cur.review === next.review && cur.mockup === next.mockup ? cur : next));
        })
        .catch(() => undefined);
    };
    tick();
    const id = window.setInterval(tick, 4000);
    const onVis = () => {
      if (!document.hidden) {
        tick();
        void refreshMe();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loggedIn, refreshMe]);

  useEffect(() => {
    if (me === null) return;
    if (
      !shouldAutoRedirectToFeishu({
        pathname: window.location.pathname,
        loggedIn,
        authError,
        apiBroken,
      })
    ) {
      return;
    }
    window.location.replace(feishuLoginHref(window.location.pathname));
  }, [me, loggedIn, authError, apiBroken]);

  useEffect(() => {
    if (!loggedIn) return;
    const stashed = takeStashedTid(TASK_STASH);
    const stashedMock = takeStashedTid(MOCK_STASH);
    const r = parsePath(window.location.pathname, window.location.search, window.location.hash);
    if (stashed && r.view === "tasks") {
      goRoute({ view: "review", taskId: stashed }, "replace");
      return;
    }
    if (stashedMock && r.view === "tasks") {
      goRoute({ view: "mockup", mockupId: stashedMock }, "replace");
      return;
    }
    setView(r.view);
    setTaskId(r.taskId ?? null);
    setMockupId(r.mockupId ?? null);
    setCompressionId(r.compressionId ?? null);
    setReceiptId(r.receipt ?? null);
    const href = hrefOf(r);
    const pathNow = `${window.location.pathname.replace(/\/+$/, "") || "/"}${window.location.search}`;
    const dirtyQuery =
      window.location.search.includes("task=") ||
      window.location.search.includes("mockup=") ||
      window.location.search.includes("tab=") ||
      window.location.hash === "#settings";
    if (dirtyQuery || pathNow !== href) window.history.replaceState({}, "", href);
  }, [loggedIn]);

  useEffect(() => {
    function onPop() {
      const r = parsePath(window.location.pathname, window.location.search, window.location.hash);
      setView(r.view);
      setTaskId(r.taskId ?? null);
      setMockupId(r.mockupId ?? null);
      setCompressionId(r.compressionId ?? null);
      setReceiptId(r.receipt ?? null);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 1024px)");
    const restore = () => setCollapsed(readCollapsed());
    narrow.addEventListener("change", restore);
    return () => narrow.removeEventListener("change", restore);
  }, []);

  function toggleSidebar() {
    setCollapsed((cur) => {
      const next = !cur;
      try {
        if (!window.matchMedia("(max-width: 1024px)").matches) {
          localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
        }
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  async function logout() {
    await api.logout();
    window.location.replace(feishuLoginHref(window.location.pathname));
  }

  function collapsePhoneSheet() {
    if (!window.matchMedia("(max-width: 720px)").matches) return;
    setCollapsed(true);
    try {
      localStorage.setItem(SIDEBAR_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  function goRoute(
    r: AppRoute,
    mode: "push" | "replace" = "push",
  ) {
    setView(r.view);
    setTaskId(r.taskId ?? null);
    setMockupId(r.mockupId ?? null);
    setCompressionId(r.compressionId ?? null);
    setReceiptId(r.receipt ?? null);
    const href = hrefOf(r);
    const cur = `${window.location.pathname.replace(/\/+$/, "") || "/"}${window.location.search}`;
    if (mode === "replace") {
      window.history.replaceState({}, "", href);
      return;
    }
    if (cur !== href) window.history.pushState({}, "", href);
  }

  function go(key: NavKey) {
    if (key === "review") {
      goRoute({ view: "tasks" });
      collapsePhoneSheet();
      return;
    }
    if (key === "mockup") {
      goRoute({ view: "mockup" });
      collapsePhoneSheet();
      return;
    }
    if (key === "compression") { goRoute({ view: "compression" }); collapsePhoneSheet(); return; }
    if (key === "history") {
      goRoute({ view: "history" });
      collapsePhoneSheet();
      return;
    }
    goRoute({ view: "settings" });
    collapsePhoneSheet();
  }

  if (me === null) {
    return (
      <AuthShell>
        <p>正在进入…</p>
      </AuthShell>
    );
  }

  if (!loggedIn) {
    if (authError || apiBroken) {
      const message = authError || apiBroken || "";
      const action = authFailureAction({
        authError,
        apiBroken,
        pathname: window.location.pathname,
        host: window.location.host,
      });
      return (
        <AuthShell title={authError ? authTitle(authError) : "进不了这间审稿室"}>
          <p>{message}</p>
          <a className="auth-result-retry" href={action.href}>
            {action.label}
          </a>
        </AuthShell>
      );
    }
    return (
      <AuthShell>
        <p>正在前往飞书授权…</p>
      </AuthShell>
    );
  }

  // A 通铺核对页：侧栏固定收成 52px 窄条（deviations 第 10 行，已批 2026-10-11），不改用户保存的展开偏好。
  const sidebarCollapsed = collapsed || view === "review";
  return (
    <div className={view === "review" ? "shell is-review-flat" : "shell"}>
      <div className="workspace">
        {!sidebarCollapsed ? (
          <button type="button" className="sidebar-scrim" aria-label="收起侧栏" onClick={toggleSidebar} />
        ) : null}
        <Sidebar
          collapsed={sidebarCollapsed}
          active={navOf(view)}
          displayName={me.display_name || "飞书用户"}
          avatarUrl={me.avatar_url}
          onNavigate={go}
          onToggle={toggleSidebar}
          onLogout={() => void logout()}
          livePulse={livePulse}
          version={version}
          isAdmin={isAdmin(me)}
        />
        <main className={view === "settings" && isAdmin(me) ? "stage stage-flush" : "stage"}>
        {view === "settings" && !isAdmin(me) ? (
          <section className="settings-denied" role="status">
            <h1 className="settings-title">设置</h1>
            <p>这里只有管理员能看</p>
            <button type="button" className="auth-result-retry" onClick={() => goRoute({ view: "tasks" })}>
              回审稿台
            </button>
          </section>
        ) : null}
        {view === "settings" && isAdmin(me) ? (
          <Suspense fallback={<PaneFallback label="打开设置…" />}>
            <SettingsPage
              canAdmin={isAdmin(me)}
              openId={me.open_id || ""}
              displayName={me.display_name}
            />
          </Suspense>
        ) : null}
        {view === "mockup" || view === "mockupNew" ? (
          <Suspense fallback={<PaneFallback label="打开 3D 打样…" />}>
            <MockupDesk
              canCreate={me.perms.includes("create")}
              canConfirmStructure={me.perms.includes("confirm_structure")}
              canAdmin={isAdmin(me)}
              openId={view === "mockupNew" ? null : mockupId}
              composing={view === "mockupNew"}
              receiptId={receiptId}
              onOpenJob={(id) => goRoute({ view: "mockup", mockupId: id })}
              onBack={() => goRoute({ view: "mockup" })}
              onCompose={() => goRoute({ view: "mockupNew" })}
              onResumeReceipt={(receipt) => goRoute({ view: "mockupNew", receipt })}
            />
          </Suspense>
        ) : null}
        {view === "compression" ? <Suspense fallback={<PaneFallback label="打开压缩文件…" />}>
          <CompressionPage id={compressionId} receiptId={receiptId} owner={me.open_id || me.display_name || ""}
            canCreate={me.perms.includes("create")} canExport={me.perms.includes("export")} canAdmin={isAdmin(me)}
            onOpen={id => goRoute({ view: "compression", compressionId: id })}
            onBack={() => goRoute({ view: "compression" })} onHistory={() => goRoute({ view: "history" })} />
        </Suspense> : null}
        {view === "history" ? (
          <Suspense fallback={<PaneFallback label="打开历史…" />}>
            <HistoryPage key={me.open_id || me.display_name || ""} owner={me.open_id || me.display_name || ""}
              onOpenCompression={id => goRoute({ view: "compression", compressionId: id })}
              canCreate={me.perms.includes("create")}
              canDelete={me.perms.includes("delete")}
              onOpenTask={(id) => goRoute({ view: "review", taskId: id })}
              onOpenMockup={(id) => goRoute({ view: "mockup", mockupId: id })}
              onOpenUpload={(kind, receipt) =>
                kind === "compression" ? goRoute({ view: "compression", receipt: receipt || undefined }) : kind === "compare"
                  ? goRoute({ view: "new", receipt: receipt || undefined })
                  : goRoute({ view: "mockupNew", receipt: receipt || undefined })
              }
            />
          </Suspense>
        ) : null}
        {view === "tasks" ? (
          <TasksPage
            canCreate={me.perms.includes("create")}
            onCreate={() => goRoute({ view: "new" })}
            onOpen={(id) => goRoute({ view: "review", taskId: id })}
            onResumeReceipt={(receipt) => goRoute({ view: "new", receipt })}
          />
        ) : null}
        {view === "new" ? (
          <NewTaskPage
            canCreate={me.perms.includes("create")}
            key={receiptId || "active"}
            receiptId={receiptId}
            onCreated={(id) => goRoute({ view: "review", taskId: id })}
            onBack={() => goRoute({ view: "tasks" })}
          />
        ) : null}
        {view === "review" ? (
          <ReviewPage
            key={`${me.open_id || "session-only"}:${taskId}`}
            userId={me.open_id || null}
            displayName={me.display_name || null}
            taskId={taskId}
            onBack={() => goRoute({ view: "tasks" })}
            onHistory={() => goRoute({ view: "history" })}
          />
        ) : null}
        </main>
      </div>
    </div>
  );
}
