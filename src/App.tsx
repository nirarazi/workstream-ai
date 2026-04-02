import { useState, useEffect, useRef, useCallback, type JSX } from "react";
import { fetchSetupStatus, fetchStatus } from "./lib/api";
import Inbox from "./components/Inbox";
import FleetBoard from "./components/FleetBoard";
import Setup from "./components/Setup";

type View = "loading" | "setup" | "inbox" | "fleet" | "settings";

function App(): JSX.Element {
  const [view, setView] = useState<View>("loading");
  const [connected, setConnected] = useState(false);
  const [platformMeta, setPlatformMeta] = useState<Record<string, unknown>>({});
  const [retryVisible, setRetryVisible] = useState(false);
  const statusInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkConnection = useCallback(async () => {
    try {
      await fetchStatus();
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }, []);

  async function init() {
    setRetryVisible(false);
    try {
      const status = await fetchSetupStatus();
      setConnected(true);
      setPlatformMeta(status.platformMeta ?? {});
      setView(status.configured ? "inbox" : "setup");
    } catch {
      setConnected(false);
      setView("loading");
      // Show retry button after a few seconds
      retryTimer.current = setTimeout(() => setRetryVisible(true), 5000);
    }
  }

  useEffect(() => {
    init();
    return () => { if (retryTimer.current) clearTimeout(retryTimer.current); };
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
        setView((v) => (v === "settings" ? "inbox" : "settings"));
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
        style={{ paddingLeft: 80, paddingRight: 16, paddingTop: 10, paddingBottom: 10 }}
      >
        <h1 data-tauri-drag-region className="text-sm font-semibold tracking-tight text-gray-300">
          ATC
        </h1>
        <div className="flex items-center gap-3">
          {/* Settings gear */}
          {view !== "loading" && view !== "setup" && (
            <button
              onClick={() => setView((v) => (v === "settings" ? "inbox" : "settings"))}
              title="Settings (Cmd+,)"
              className="cursor-pointer text-gray-500 hover:text-gray-300 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                <path fillRule="evenodd" d="M8.34 1.804A1 1 0 0 1 9.32 1h1.36a1 1 0 0 1 .98.804l.295 1.473c.497.144.971.342 1.416.587l1.25-.834a1 1 0 0 1 1.262.125l.962.962a1 1 0 0 1 .125 1.262l-.834 1.25c.245.445.443.919.587 1.416l1.473.294a1 1 0 0 1 .804.98v1.361a1 1 0 0 1-.804.98l-1.473.295a6.95 6.95 0 0 1-.587 1.416l.834 1.25a1 1 0 0 1-.125 1.262l-.962.962a1 1 0 0 1-1.262.125l-1.25-.834a6.953 6.953 0 0 1-1.416.587l-.294 1.473a1 1 0 0 1-.98.804H9.32a1 1 0 0 1-.98-.804l-.295-1.473a6.957 6.957 0 0 1-1.416-.587l-1.25.834a1 1 0 0 1-1.262-.125l-.962-.962a1 1 0 0 1-.125-1.262l.834-1.25a6.957 6.957 0 0 1-.587-1.416l-1.473-.294A1 1 0 0 1 1 11.06V9.7a1 1 0 0 1 .804-.98l1.473-.295c.144-.497.342-.971.587-1.416l-.834-1.25a1 1 0 0 1 .125-1.262l.962-.962A1 1 0 0 1 5.38 3.41l1.25.834a6.957 6.957 0 0 1 1.416-.587l.294-1.473ZM13 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" clipRule="evenodd" />
              </svg>
            </button>
          )}

          {/* Connection indicator */}
          <div data-tauri-drag-region className="flex items-center gap-2">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                connected ? "bg-green-500" : "bg-red-500"
              }`}
            />
            <span className="text-xs text-gray-500">
              {connected ? "Connected" : "Disconnected"}
            </span>
          </div>
        </div>
      </header>

      {/* Tab bar — only visible when configured */}
      {(view === "inbox" || view === "fleet") && (
        <nav className="border-b border-gray-800 bg-gray-950 px-6 flex items-center gap-6">
          <button
            onClick={() => setView("inbox")}
            className={`cursor-pointer py-2.5 text-sm font-medium border-b-2 transition-colors ${
              view === "inbox"
                ? "border-blue-500 text-gray-200"
                : "border-transparent text-gray-500 hover:text-gray-300"
            }`}
          >
            Inbox
          </button>
          <button
            onClick={() => setView("fleet")}
            className={`cursor-pointer py-2.5 text-sm font-medium border-b-2 transition-colors ${
              view === "fleet"
                ? "border-blue-500 text-gray-200"
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
              <h2 className="text-2xl font-bold tracking-tight text-gray-200 mb-2">ATC</h2>
              <p className="text-sm text-gray-500">Air Traffic Control for Agent Fleets</p>
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
        {view === "inbox" && <Inbox platformMeta={platformMeta} />}
        {view === "fleet" && <FleetBoard platformMeta={platformMeta} />}
        {view === "settings" && (
          <Setup onComplete={() => { init(); setView("inbox"); }} />
        )}
      </main>
    </div>
  );
}

export default App;
