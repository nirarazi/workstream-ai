import { useState, type JSX } from "react";
import { decideDigestCheck, type DigestCheck } from "../../lib/api";
import StatusBadge from "../StatusBadge";

interface DigestChecksProps {
  checks: DigestCheck[];
  /** After a decision, so the lists refresh */
  onDecided: () => Promise<void> | void;
  /** Opens the work item in the detail pane */
  onOpen: (workItemId: string) => void;
  selectedWorkItemId?: string | null;
}

/** Characters that reorder how text displays (bidirectional controls): untrusted text could use them to mislead */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

const keyOf = (check: DigestCheck) => `${check.eventId}:${check.workItemId}`;

/**
 * Digest disagreements the judge couldn't settle, at the top of Needs me: what a digest says about an item against
 * what the app believes, for the operator to decide. Digest text and the judge's note are untrusted: plain text only.
 */
export default function DigestChecks({ checks, onDecided, onOpen, selectedWorkItemId }: DigestChecksProps): JSX.Element | null {
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  if (checks.length === 0) return null;

  async function decide(check: DigestCheck, verdict: "app" | "digest") {
    const key = keyOf(check);
    setBusy((prev) => new Set(prev).add(key));
    setError(null);
    try {
      await decideDigestCheck(check.eventId, check.workItemId, verdict);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      // Already settled elsewhere (another window, or the item moved on): the refresh below shows where it stands
      if (!/\b(404|409)\b/.test(message)) setError("Couldn't save that decision. Try again.");
    } finally {
      await onDecided();
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  return (
    <section aria-labelledby="digest-checks-heading" className="border-b border-gray-800 bg-gray-900/40">
      <h2 id="digest-checks-heading" className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        Digest disagreements · {checks.length}
      </h2>
      {error && <div role="alert" className="px-4 py-1 text-xs text-red-400">{error}</div>}
      {checks.map((check) => {
        const key = keyOf(check);
        const titleId = `digest-check-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
        const isBusy = busy.has(key);
        const isExpanded = expanded.has(key);
        const clean = (value: string) => value.replace(BIDI_CONTROLS, "");
        const text = clean(check.digestText);
        return (
          <div key={key} role="group" aria-labelledby={titleId} className="px-4 py-3 border-t border-gray-800/60 text-xs">
            <button
              id={titleId}
              type="button"
              onClick={() => onOpen(check.workItemId)}
              aria-current={selectedWorkItemId === check.workItemId ? "true" : undefined}
              className="text-left font-medium text-gray-200 hover:underline cursor-pointer"
            >
              {clean(check.title || check.workItemId)}
            </button>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-gray-400">
              <span>{check.sender ? clean(check.sender) : "A digest"} says</span>
              <StatusBadge status={check.digestStatus} />
              {check.digestSaysNeedsYou && <span className="text-gray-500">(needs you)</span>}
              {!check.aboutThisItem && <span className="text-gray-500">(of the whole digest, not this item)</span>}
              <span>· the app has</span>
              {check.appStatus ? <StatusBadge status={check.appStatus} /> : <span className="text-gray-500">no status</span>}
            </div>
            <p className={`mt-1.5 text-gray-500 whitespace-pre-wrap ${isExpanded ? "" : "line-clamp-3"}`}>{text}</p>
            <button
              type="button"
              onClick={() => setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key); else next.add(key);
                return next;
              })}
              className="mt-0.5 text-[11px] text-gray-600 hover:text-gray-400 cursor-pointer"
            >
              {isExpanded ? "Show less" : "Show the whole digest"}
            </button>
            {check.judgeNote && <p className="mt-1 text-gray-600 italic">Model's note: {clean(check.judgeNote)}</p>}
            <div className="mt-2 flex gap-2">
              {check.aboutThisItem && (
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => decide(check, "digest")}
                  className="px-2.5 py-1 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-50 cursor-pointer"
                >
                  Digest is right
                </button>
              )}
              <button
                type="button"
                disabled={isBusy}
                onClick={() => decide(check, "app")}
                className="px-2.5 py-1 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-50 cursor-pointer"
              >
                {check.aboutThisItem ? "App is right" : "Dismiss"}
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
