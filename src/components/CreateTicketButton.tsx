import { useState, useRef, useEffect } from "react";
import { createTicket, openExternalUrl, fetchStatus } from "../lib/api";

interface CreateTicketButtonProps {
  workItemId: string;
  disabled?: boolean;
  onCreated?: () => void;
  onError?: (msg: string) => void;
}

export default function CreateTicketButton({ workItemId, disabled, onCreated, onError }: CreateTicketButtonProps) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [projectKeys, setProjectKeys] = useState<string[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  // Fetch project keys on first open
  useEffect(() => {
    if (!open || projectKeys !== null) return;
    fetchStatus().then((s) => setProjectKeys(s.projectKeys ?? [])).catch(() => setProjectKeys([]));
  }, [open, projectKeys]);

  async function doCreate(projectKey: string) {
    setCreating(true);
    setOpen(false);
    try {
      const result = await createTicket(workItemId, projectKey);
      if (result.ticketUrl) openExternalUrl(result.ticketUrl);
      onCreated?.();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Failed to create ticket");
    } finally {
      setCreating(false);
    }
  }

  function handleClick() {
    if (projectKeys && projectKeys.length === 1) {
      doCreate(projectKeys[0]);
    } else {
      setOpen(!open);
    }
  }

  const busy = disabled || creating;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={handleClick}
        disabled={busy}
        className="cursor-pointer rounded px-3 py-1.5 text-xs font-medium bg-purple-800/70 hover:bg-purple-700 text-purple-200 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {creating ? "..." : "Create Ticket"}
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 right-0 bg-gray-900 border border-gray-700 rounded-lg py-1 shadow-xl min-w-[120px] z-20">
          {projectKeys === null ? (
            <div className="px-3 py-1.5 text-xs text-gray-500">Loading...</div>
          ) : projectKeys.length === 0 ? (
            <div className="px-3 py-1.5 text-xs text-gray-500">No projects configured</div>
          ) : (
            projectKeys.map((key) => (
              <button
                key={key}
                onClick={() => doCreate(key)}
                className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 cursor-pointer"
              >
                {key}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
