import { useState, useEffect } from "react";

interface SendConfirmationProps {
  channelName: string;
  action: string;
  onComplete: () => void;
}

const ACTION_CONFIG: Record<string, { label: string; sublabel: string; color: string; icon: string }> = {
  unblock:  { label: "Unblocked",  sublabel: "Agent will continue from here", color: "cyan",  icon: "arrow" },
  redirect: { label: "Unblocked",  sublabel: "Agent will continue from here", color: "cyan",  icon: "arrow" },
  done:     { label: "Complete",   sublabel: "Nice work",                      color: "green", icon: "check" },
  approve:  { label: "Complete",   sublabel: "Nice work",                      color: "green", icon: "check" },
  dismiss:  { label: "Dismissed",  sublabel: "Cleared from stream",            color: "gray",  icon: "check" },
  close:    { label: "Dismissed",  sublabel: "Cleared from stream",            color: "gray",  icon: "check" },
};

const COLOR_CLASSES = {
  cyan:  { text: "text-cyan-400",  ring: "stroke-cyan-400/30",  check: "stroke-cyan-400",  bg: "bg-cyan-500/5" },
  green: { text: "text-green-400", ring: "stroke-green-400/30", check: "stroke-green-400", bg: "bg-green-500/5" },
  gray:  { text: "text-gray-400",  ring: "stroke-gray-500/30",  check: "stroke-gray-400",  bg: "bg-gray-500/5" },
};

export default function SendConfirmation({ channelName, action, onComplete }: SendConfirmationProps) {
  const [phase, setPhase] = useState<"in" | "out">("in");

  const config = ACTION_CONFIG[action] ?? ACTION_CONFIG.unblock;
  const colors = COLOR_CLASSES[config.color as keyof typeof COLOR_CLASSES] ?? COLOR_CLASSES.cyan;

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase("out"), 1400),
      setTimeout(onComplete, 1900),
    ];
    return () => timers.forEach(clearTimeout);
  }, [onComplete]);

  return (
    <div
      className={`flex flex-col items-center justify-center py-6 transition-opacity duration-400 ${
        phase === "out" ? "opacity-0" : "opacity-100"
      } ${colors.bg}`}
    >
      {/* Animated icon */}
      <div className="relative w-10 h-10 mb-3">
        <svg viewBox="0 0 40 40" className="w-10 h-10">
          <circle
            cx="20" cy="20" r="17"
            fill="none"
            className={colors.ring}
            strokeWidth="1.5"
            strokeDasharray="107"
            strokeDashoffset="107"
            style={{ animation: "confirm-ring 0.4s ease-out forwards" }}
          />
          {config.icon === "arrow" ? (
            <path
              d="M14 20h12M22 15l4 5-4 5"
              fill="none"
              className={colors.check}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray="30"
              strokeDashoffset="30"
              style={{ animation: "confirm-icon 0.3s ease-out 0.2s forwards" }}
            />
          ) : (
            <path
              d="M13 21l5 5 9-10"
              fill="none"
              className={colors.check}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray="24"
              strokeDashoffset="24"
              style={{ animation: "confirm-icon 0.3s ease-out 0.2s forwards" }}
            />
          )}
        </svg>
      </div>

      {/* Label */}
      <div
        className={`text-sm font-medium ${colors.text}`}
        style={{ animation: "confirm-text 0.3s ease-out 0.15s both" }}
      >
        {config.label}
      </div>

      {/* Channel + sublabel */}
      <div
        className="text-xs text-gray-500 mt-1"
        style={{ animation: "confirm-text 0.3s ease-out 0.25s both" }}
      >
        Reply sent to #{channelName} · {config.sublabel}
      </div>
    </div>
  );
}
