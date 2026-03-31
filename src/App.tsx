import { useState, useEffect, useRef, useCallback, type JSX } from "react";
import { fetchSetupStatus, fetchStatus } from "./lib/api";
import Inbox from "./components/Inbox";
import Setup from "./components/Setup";

type View = "loading" | "setup" | "inbox";

function App(): JSX.Element {
  const [view, setView] = useState<View>("loading");
  const [connected, setConnected] = useState(false);
  const statusInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check connection status periodically
  const checkConnection = useCallback(async () => {
    try {
      await fetchStatus();
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }, []);

  // Initial load: check if setup is needed
  useEffect(() => {
    async function init() {
      try {
        const status = await fetchSetupStatus();
        setConnected(true);
        setView(status.configured ? "inbox" : "setup");
      } catch {
        setConnected(false);
        // Even if we can't reach the server, show the inbox
        // so the user can see the connection error state
        setView("inbox");
      }
    }
    init();
  }, []);

  // Poll connection status
  useEffect(() => {
    checkConnection();
    statusInterval.current = setInterval(checkConnection, 10000);
    return () => {
      if (statusInterval.current) clearInterval(statusInterval.current);
    };
  }, [checkConnection]);

  function handleSetupComplete() {
    setView("inbox");
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">ATC</h1>
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              connected ? "bg-green-500" : "bg-red-500"
            }`}
          />
          <span className="text-xs text-gray-500">
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
      </header>

      {/* Main content */}
      <main className="p-6">
        {view === "loading" && (
          <div className="flex items-center justify-center py-20">
            <p className="text-sm text-gray-500">Connecting to ATC engine...</p>
          </div>
        )}
        {view === "setup" && <Setup onComplete={handleSetupComplete} />}
        {view === "inbox" && <Inbox />}
      </main>
    </div>
  );
}

export default App;
