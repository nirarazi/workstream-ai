import type { JSX, ReactNode } from "react";

interface TooltipProps {
  text: string;
  children: ReactNode;
}

/**
 * Styled tooltip that appears on hover.
 * CSS-only — no JS state, no portal, no library.
 */
export default function Tooltip({ text, children }: TooltipProps): JSX.Element {
  return (
    <span className="relative group/tip inline-flex">
      {children}
      <span
        role="tooltip"
        className="
          pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2
          whitespace-nowrap rounded bg-gray-800 border border-gray-700
          px-2.5 py-1.5 text-[11px] leading-tight text-gray-300
          opacity-0 transition-opacity duration-150
          group-hover/tip:opacity-100
          z-50 shadow-lg
        "
      >
        {text}
      </span>
    </span>
  );
}
