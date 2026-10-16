import { useState, type JSX } from "react";
import { decideDigestCheck, type DigestCheck } from "../../lib/api";
import StatusBadge from "../StatusBadge";

interface DigestChecksProps {
  checks: DigestCheck[];
  /** After a decision, so the lists refresh */
  onDecided: () => void;
  /** Opens the work item in the detail pane */
  onOpen: (workItemId: string) => void;
}

/**
 * Digest disagreements the judge couldn't settle, at the top of Needs me: what a digest says about an item against
 * what the app believes, for the operator to decide. Digest text is untrusted: shown as plain text only.
 */
export default function DigestChecks({ checks, onDecided, onOpen }: DigestChecksProps): JSX.Element | null {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (checks.length === 0) return null;

  async function decide(check: DigestCheck, verdict: "app" | "digest") {
    const key = `${check.eventId}:${check.workItemId}`;
    setBusy(key);
    setError(null);
    try {
      await decideDigestCheck(check.eventId, check.workItemId, verdict);
      onDecided();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label="Digest disagreements" className="border-b border-gray-800 bg-gray-900/40">
      <h2 className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        Digest disagreements · {checks.length}
      </h2>
      {error && <div className="px-4 py-1 text-xs text-red-400">{error}</div>}
      {checks.map((check) => {
        const key = `${check.eventId}:${check.workItemId}`;
        return (
          <div key={key} className="px-4 py-3 border-t border-gray-800/60 text-xs">
            <button
              type="button"
              onClick={() => onOpen(check.workItemId)}
              className="text-left font-medium text-gray-200 hover:underline cursor-pointer"
            >
              {check.title || check.workItemId}
            </button>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-gray-400">
              <span>{check.sender ?? "A digest"} says</span>
              <StatusBadge status={check.digestStatus} />
              {check.digestSaysNeedsYou && <span className="text-gray-500">(needs you)</span>}
              <span>· the app has</span>
              <StatusBadge status={check.appStatus ?? "noise"} />
            </div>
            <p className="mt-1.5 text-gray-500 line-clamp-3 whitespace-pre-wrap">{check.digestText}</p>
            {check.judgeNote && <p className="mt-1 text-gray-600 italic">Judge: {check.judgeNote}</p>}
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={busy === key}
                onClick={() => decide(check, "digest")}
                className="px-2.5 py-1 rounded bg-cyan-900/50 text-cyan-300 hover:bg-cyan-800/60 disabled:opacity-50 cursor-pointer"
              >
                Digest is right
              </button>
              <button
                type="button"
                disabled={busy === key}
                onClick={() => decide(check, "app")}
                className="px-2.5 py-1 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-50 cursor-pointer"
              >
                App is right
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
