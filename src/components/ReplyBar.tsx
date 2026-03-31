import { useState, type JSX } from "react";
import { postReply } from "../lib/api";

interface ReplyBarProps {
  threadId: string;
  channelId: string;
}

export default function ReplyBar({ threadId, channelId }: ReplyBarProps): JSX.Element {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend() {
    const trimmed = message.trim();
    if (!trimmed || sending) return;

    setSending(true);
    setError(null);
    try {
      await postReply(threadId, channelId, trimmed);
      setMessage("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="mt-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Reply to thread..."
          disabled={sending}
          className="flex-1 rounded border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-gray-500 disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={sending || !message.trim()}
          className="rounded bg-gray-700 px-3 py-1.5 text-sm font-medium text-gray-200 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {sending ? "Sending..." : "Send"}
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}
