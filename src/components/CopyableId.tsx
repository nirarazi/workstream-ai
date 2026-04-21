import { useState, useCallback, type JSX } from "react";

interface CopyableIdProps {
  id: string;
}

export default function CopyableId({ id }: CopyableIdProps): JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [id]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-1 font-mono text-[10px] text-gray-600 hover:text-gray-400 cursor-pointer transition-colors"
    >
      {id}
      <svg className={`w-3 h-3 transition-opacity duration-150 ${copied ? "opacity-100 text-green-400" : "opacity-0"}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 8.5l3.5 3.5 6.5-7" />
      </svg>
    </button>
  );
}
