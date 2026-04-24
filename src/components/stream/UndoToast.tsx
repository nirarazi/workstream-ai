import { useEffect, useState } from "react";

interface UndoToastProps {
  message: string;
  duration?: number; // ms, default 5000
  onUndo: () => void;
  onExpire: () => void;
}

export default function UndoToast({ message, duration = 5000, onUndo, onExpire }: UndoToastProps) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(onExpire, 300); // wait for exit animation
    }, duration);
    return () => clearTimeout(timer);
  }, [duration, onExpire]);

  return (
    <div
      className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 transition-all duration-300 ${
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
      }`}
    >
      <div className="bg-gray-800 border border-gray-600 rounded-lg px-4 py-2.5 flex items-center gap-4 shadow-lg">
        <span className="text-sm text-gray-200">✓ {message}</span>
        <button
          onClick={() => {
            onUndo();
            setVisible(false);
          }}
          className="text-purple-400 hover:text-purple-300 text-sm font-semibold flex items-center gap-1"
        >
          Undo <kbd className="text-[10px] bg-gray-700 px-1.5 py-0.5 rounded ml-1">⌘Z</kbd>
        </button>
      </div>
    </div>
  );
}
