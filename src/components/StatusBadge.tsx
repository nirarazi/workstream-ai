import { type JSX } from "react";

const STATUS_CONFIG: Record<string, { label: string; classes: string }> = {
  blocked_on_human: {
    label: "Blocked",
    classes: "bg-red-900/60 text-red-300 border-red-700/50",
  },
  needs_decision: {
    label: "Needs Decision",
    classes: "bg-red-900/60 text-red-300 border-red-700/50",
  },
  in_progress: {
    label: "In Progress",
    classes: "bg-amber-900/60 text-amber-300 border-amber-700/50",
  },
  completed: {
    label: "Completed",
    classes: "bg-green-900/60 text-green-300 border-green-700/50",
  },
  noise: {
    label: "Noise",
    classes: "bg-gray-800/60 text-gray-400 border-gray-700/50",
  },
};

export type ActionState = "replied" | "unblocked" | "done" | "snoozed" | null;

interface StatusBadgeProps {
  status: string;
  actionState?: ActionState;
  snoozedUntil?: string | null;
}

function formatSnoozedLabel(snoozedUntil: string | null | undefined): string {
  if (!snoozedUntil) return "Snoozed";
  const diffMs = new Date(snoozedUntil).getTime() - Date.now();
  if (diffMs <= 0) return "Snoozed";
  const hours = Math.ceil(diffMs / 3600000);
  return `Snoozed ${hours}h`;
}

export default function StatusBadge({ status, actionState, snoozedUntil }: StatusBadgeProps): JSX.Element {
  if (actionState === "replied") {
    return (
      <span className="inline-block rounded-full border px-2 py-0.5 text-xs font-medium leading-tight bg-green-900/60 text-green-300 border-green-700/50">
        Replied
      </span>
    );
  }

  if (actionState === "unblocked") {
    return (
      <span className="inline-block rounded-full border px-2 py-0.5 text-xs font-medium leading-tight bg-green-900/60 text-green-300 border-green-700/50">
        ✓ Unblocked
      </span>
    );
  }

  if (actionState === "done") {
    return (
      <span className="inline-block rounded-full border px-2 py-0.5 text-xs font-medium leading-tight bg-green-900/60 text-green-300 border-green-700/50">
        ✓ Done
      </span>
    );
  }

  if (actionState === "snoozed") {
    return (
      <span className="inline-block rounded-full border px-2 py-0.5 text-xs font-medium leading-tight bg-amber-900/60 text-amber-300 border-amber-700/50">
        {formatSnoozedLabel(snoozedUntil)}
      </span>
    );
  }

  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.noise;
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium leading-tight ${config.classes}`}
    >
      {config.label}
    </span>
  );
}
