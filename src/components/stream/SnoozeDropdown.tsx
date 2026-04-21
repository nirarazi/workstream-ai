import { useState, useRef, useEffect } from "react";

interface SnoozeDropdownProps {
  disabled: boolean;
  onSnooze: (durationSeconds: number) => void;
}

interface SnoozeOption {
  label: string;
  seconds: number | (() => number);
}

const SNOOZE_OPTIONS: SnoozeOption[] = [
  { label: "30 minutes", seconds: 30 * 60 },
  { label: "1 hour", seconds: 60 * 60 },
  { label: "3 hours", seconds: 3 * 60 * 60 },
  {
    label: "Tomorrow morning",
    seconds: () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      return Math.max(60, Math.floor((tomorrow.getTime() - Date.now()) / 1000));
    },
  },
  {
    label: "Next Monday",
    seconds: () => {
      const now = new Date();
      const daysUntilMonday = ((8 - now.getDay()) % 7) || 7;
      const monday = new Date(now);
      monday.setDate(now.getDate() + daysUntilMonday);
      monday.setHours(9, 0, 0, 0);
      return Math.max(60, Math.floor((monday.getTime() - Date.now()) / 1000));
    },
  },
];

export default function SnoozeDropdown({ disabled, onSnooze }: SnoozeDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  function handleSelect(option: SnoozeOption) {
    const seconds = typeof option.seconds === "function" ? option.seconds() : option.seconds;
    onSnooze(seconds);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        disabled={disabled}
        className="cursor-pointer rounded px-3 py-1.5 text-xs font-medium bg-amber-800/70 hover:bg-amber-700 text-amber-200 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
      >
        Snooze <span className="text-[9px]">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 right-0 bg-gray-900 border border-gray-700 rounded-lg py-1 shadow-xl min-w-[160px] z-20">
          {SNOOZE_OPTIONS.map((option) => (
            <button
              key={option.label}
              onClick={() => handleSelect(option)}
              className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 cursor-pointer"
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
