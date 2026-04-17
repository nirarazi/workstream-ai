import { useState, useEffect, useRef, useCallback, type JSX } from "react";
import { fetchSetupStatus, fetchStatus, type ServiceStatuses } from "./lib/api";
import { useTheme, type ThemeMode } from "./lib/theme";
import Stream from "./components/Inbox";
import FleetBoard from "./components/FleetBoard";
import Sidekick from "./components/Sidekick";
import Setup from "./components/Setup";

type View = "loading" | "setup" | "stream" | "fleet" | "settings";
type DotStatus = "ok" | "degraded" | "disconnected";

const DEFAULT_SERVICES: ServiceStatuses = {};

const DOT_CLASSES: Record<DotStatus, string> = {
  ok: "bg-green-500 animate-[pulse_3s_ease-in-out_infinite]",
  degraded: "bg-amber-500 animate-pulse",
  disconnected: "bg-gray-600",
};

function ServiceDot({ label, status }: { label: string; status: DotStatus }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-2 w-2 rounded-full ${DOT_CLASSES[status]}`} />
      <span className="text-[11px] text-gray-500">{label}</span>
    </span>
  );
}

const THEME_ICONS: Record<ThemeMode, JSX.Element> = {
  dark: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
      <path fillRule="evenodd" d="M7.455 2.004a.75.75 0 0 1 .26.77 7 7 0 0 0 9.958 7.967.75.75 0 0 1 1.067.853A8.5 8.5 0 1 1 6.647 1.921a.75.75 0 0 1 .808.083Z" clipRule="evenodd" />
    </svg>
  ),
  light: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
      <path d="M10 2a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 2ZM10 15a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 15ZM10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM15.657 5.404a.75.75 0 1 0-1.06-1.06l-1.061 1.06a.75.75 0 0 0 1.06 1.06l1.06-1.06ZM6.464 14.596a.75.75 0 1 0-1.06-1.06l-1.06 1.06a.75.75 0 0 0 1.06 1.06l1.06-1.06ZM18 10a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 18 10ZM5 10a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 5 10ZM14.596 15.657a.75.75 0 0 0 1.06-1.06l-1.06-1.061a.75.75 0 1 0-1.06 1.06l1.06 1.06ZM5.404 6.464a.75.75 0 0 0 1.06-1.06l-1.06-1.06a.75.75 0 1 0-1.06 1.06l1.06 1.06Z" />
    </svg>
  ),
  system: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
      <path fillRule="evenodd" d="M2 4.25A2.25 2.25 0 0 1 4.25 2h11.5A2.25 2.25 0 0 1 18 4.25v8.5A2.25 2.25 0 0 1 15.75 15h-3.105a3.501 3.501 0 0 0 1.1 1.677A.75.75 0 0 1 13.26 18H6.74a.75.75 0 0 1-.484-1.323A3.501 3.501 0 0 0 7.355 15H4.25A2.25 2.25 0 0 1 2 12.75v-8.5Zm1.5 0a.75.75 0 0 1 .75-.75h11.5a.75.75 0 0 1 .75.75v7.5a.75.75 0 0 1-.75.75H4.25a.75.75 0 0 1-.75-.75v-7.5Z" clipRule="evenodd" />
    </svg>
  ),
};

const THEME_LABELS: Record<ThemeMode, string> = {
  dark: "Dark mode",
  light: "Light mode",
  system: "System theme",
};

function App(): JSX.Element {
  const [view, setView] = useState<View>("loading");
  const [connected, setConnected] = useState(false);
  const [platformMeta, setPlatformMeta] = useState<Record<string, unknown>>({});
  const [retryVisible, setRetryVisible] = useState(false);
  const [sidekickOpen, setSidekickOpen] = useState(false);
  const [services, setServices] = useState<ServiceStatuses>(DEFAULT_SERVICES);
  const { mode: themeMode, cycle: cycleTheme } = useTheme();
  const statusInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkConnection = useCallback(async () => {
    try {
      const status = await fetchStatus();
      setConnected(true);
      setServices(status.services);
    } catch {
      setConnected(false);
      setServices(DEFAULT_SERVICES);
    }
  }, []);

  const initAttempts = useRef(0);
  const initPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function init() {
    setRetryVisible(false);
    initAttempts.current++;
    try {
      const status = await fetchSetupStatus();
      // Success — stop polling and show the app
      initAttempts.current = 0;
      if (initPollTimer.current) { clearTimeout(initPollTimer.current); initPollTimer.current = null; }
      setConnected(true);
      setPlatformMeta(status.platformMeta ?? {});
      setView(status.configured ? "stream" : "setup");
    } catch {
      setConnected(false);
      setView("loading");
      // Show manual retry after 3 failed attempts (~6s)
      if (initAttempts.current >= 3) setRetryVisible(true);
      // Auto-retry every 2s until success
      initPollTimer.current = setTimeout(() => init(), 2000);
    }
  }

  useEffect(() => {
    init();
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (initPollTimer.current) clearTimeout(initPollTimer.current);
    };
  }, []);

  // Poll connection status
  useEffect(() => {
    checkConnection();
    statusInterval.current = setInterval(checkConnection, 10000);
    return () => {
      if (statusInterval.current) clearInterval(statusInterval.current);
    };
  }, [checkConnection]);

  // Cmd+, (Mac) / Ctrl+, (other) toggles settings
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "," && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setView((v) => (v === "settings" ? "stream" : "settings"));
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Cmd+K toggles sidekick
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSidekickOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  function handleSetupComplete() {
    // Re-init to pick up new platformMeta
    init();
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Title bar — Tauri window drag region */}
      <header
        data-tauri-drag-region
        className="sticky top-0 z-50 border-b border-gray-800 bg-gray-950 flex items-center justify-between"
        style={{ paddingLeft: 78, paddingRight: 16, paddingTop: 8, paddingBottom: 7 }}
      >
        <h1 data-tauri-drag-region className="text-sm font-semibold tracking-tight text-gray-300">
          workstream.ai
        </h1>
        <div className="flex items-center gap-3">
          {/* Theme toggle */}
          {view !== "loading" && view !== "setup" && (
            <button
              onClick={cycleTheme}
              title={THEME_LABELS[themeMode]}
              className="cursor-pointer text-gray-500 hover:text-gray-300 transition-colors"
            >
              {THEME_ICONS[themeMode]}
            </button>
          )}

          {/* Settings gear */}
          {view !== "loading" && view !== "setup" && (
            <button
              onClick={() => setView((v) => (v === "settings" ? "stream" : "settings"))}
              title="Settings (Cmd+,)"
              className="cursor-pointer text-gray-500 hover:text-gray-300 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                <path fillRule="evenodd" d="M8.34 1.804A1 1 0 0 1 9.32 1h1.36a1 1 0 0 1 .98.804l.295 1.473c.497.144.971.342 1.416.587l1.25-.834a1 1 0 0 1 1.262.125l.962.962a1 1 0 0 1 .125 1.262l-.834 1.25c.245.445.443.919.587 1.416l1.473.294a1 1 0 0 1 .804.98v1.361a1 1 0 0 1-.804.98l-1.473.295a6.95 6.95 0 0 1-.587 1.416l.834 1.25a1 1 0 0 1-.125 1.262l-.962.962a1 1 0 0 1-1.262.125l-1.25-.834a6.953 6.953 0 0 1-1.416.587l-.294 1.473a1 1 0 0 1-.98.804H9.32a1 1 0 0 1-.98-.804l-.295-1.473a6.957 6.957 0 0 1-1.416-.587l-1.25.834a1 1 0 0 1-1.262-.125l-.962-.962a1 1 0 0 1-.125-1.262l.834-1.25a6.957 6.957 0 0 1-.587-1.416l-1.473-.294A1 1 0 0 1 1 11.06V9.7a1 1 0 0 1 .804-.98l1.473-.295c.144-.497.342-.971.587-1.416l-.834-1.25a1 1 0 0 1 .125-1.262l.962-.962A1 1 0 0 1 5.38 3.41l1.25.834a6.957 6.957 0 0 1 1.416-.587l.294-1.473ZM13 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" clipRule="evenodd" />
              </svg>
            </button>
          )}

          {/* Service indicators */}
          <div data-tauri-drag-region className="flex items-center gap-3">
            <ServiceDot label="Engine" status={connected ? "ok" : "disconnected"} />
            {Object.entries(services).map(([name, status]) => (
              <ServiceDot key={name} label={name} status={connected ? status : "disconnected"} />
            ))}
          </div>
        </div>
      </header>

      {/* Tab bar — sticky below title bar */}
      {(view === "stream" || view === "fleet") && (
        <nav className="sticky top-[41px] z-40 border-b border-gray-800 bg-gray-950 px-6 flex items-center gap-6">
          <button
            onClick={() => setView("stream")}
            className={`cursor-pointer py-2.5 text-sm font-medium border-b-2 transition-colors ${
              view === "stream"
                ? "border-cyan-500 text-gray-200"
                : "border-transparent text-gray-500 hover:text-gray-300"
            }`}
          >
            Stream
          </button>
          <button
            onClick={() => setView("fleet")}
            className={`cursor-pointer py-2.5 text-sm font-medium border-b-2 transition-colors ${
              view === "fleet"
                ? "border-cyan-500 text-gray-200"
                : "border-transparent text-gray-500 hover:text-gray-300"
            }`}
          >
            Fleet
          </button>
        </nav>
      )}

      {/* Main content */}
      <main className="p-6">
        {view === "loading" && (
          <div className="flex flex-col items-center justify-center py-32 gap-6">
            <div className="text-center">
              <h2 className="text-2xl font-bold tracking-tight text-gray-200 mb-2">workstream.ai</h2>
              <p className="text-sm text-gray-500">The operator's inbox for AI agent fleets</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
              <span className="text-sm text-gray-400">Connecting to engine...</span>
            </div>
            {retryVisible && (
              <button
                onClick={() => init()}
                className="cursor-pointer rounded border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800 transition-colors"
              >
                Retry connection
              </button>
            )}
          </div>
        )}
        {view === "setup" && <Setup onComplete={handleSetupComplete} />}
        {view === "stream" && <Stream platformMeta={platformMeta} />}
        {view === "fleet" && <FleetBoard platformMeta={platformMeta} />}
        {view === "settings" && (
          <Setup onComplete={() => { init(); setView("stream"); }} />
        )}
      </main>
      {sidekickOpen && <Sidekick onClose={() => setSidekickOpen(false)} />}
    </div>
  );
}

export default App;
