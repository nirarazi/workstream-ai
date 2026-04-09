import { type JSX } from "react";

const STATUS_CONFIG: Record<string, { label: string; classes: string }> = {
  blocked_on_human: {
    label: "Blocked",
    classes: "bg-red-900/60 text-red-300 border-red-700/50",
  },
  needs_decision: {
    label: "Needs Decision",
    classes: "bg-amber-900/60 text-amber-300 border-amber-700/50",
  },
  completed: {
    label: "Completed",
    classes: "bg-green-900/60 text-green-300 border-green-700/50",
  },
  in_progress: {
    label: "In Progress",
    classes: "bg-cyan-900/60 text-cyan-300 border-cyan-700/50",
  },
  noise: {
    label: "Noise",
    classes: "bg-gray-800/60 text-gray-400 border-gray-700/50",
  },
};

interface StatusBadgeProps {
  status: string;
}

export default function StatusBadge({ status }: StatusBadgeProps): JSX.Element {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.noise;
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium leading-tight ${config.classes}`}
    >
      {config.label}
    </span>
  );
}
