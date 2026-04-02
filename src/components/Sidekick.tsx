import { useState, useRef, useEffect, type JSX } from "react";
import { askSidekick, type SidekickMessage, type SidekickResult } from "../lib/api";

interface SidekickProps {
  onClose: () => void;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export default function Sidekick({ onClose }: SidekickProps): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || loading) return;

    const newMessages: ChatMessage[] = [...messages, { role: "user", content: question }];
    setMessages(newMessages);
    setInput("");
    setLoading(true);

    try {
      // Build history for the API (exclude the current question)
      const history: SidekickMessage[] = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const result = await askSidekick(question, history);
      setMessages([...newMessages, { role: "assistant", content: result.answer }]);
    } catch (err) {
      setMessages([
        ...newMessages,
        { role: "assistant", content: "Sorry, I couldn't process that question." },
      ]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center">
      <div
        ref={panelRef}
        className="w-full max-w-2xl bg-gray-950 border border-gray-800 border-b-0 rounded-t-xl shadow-2xl flex flex-col"
        style={{ height: "40vh", minHeight: 300 }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-300">Ask ATC</span>
            <span className="text-xs text-gray-600">Cmd+K</span>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 cursor-pointer text-sm"
          >
            &#x2715;
          </button>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {messages.length === 0 && !loading && (
            <div className="text-center py-8">
              <p className="text-sm text-gray-500">
                Ask me anything about your fleet.
              </p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {[
                  "What happened overnight?",
                  "Which items are blocked?",
                  "What is Byte working on?",
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => { setInput(suggestion); inputRef.current?.focus(); }}
                    className="cursor-pointer rounded-full border border-gray-700 px-3 py-1 text-xs text-gray-400 hover:text-gray-200 hover:border-gray-600"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div
              key={i}
              className={`text-sm ${
                msg.role === "user"
                  ? "text-gray-200 font-medium"
                  : "text-gray-400 whitespace-pre-wrap"
              }`}
            >
              {msg.role === "user" ? (
                <div className="flex items-start gap-2">
                  <span className="text-xs text-gray-600 mt-0.5">You:</span>
                  <span>{msg.content}</span>
                </div>
              ) : (
                <div className="bg-gray-900 rounded-lg px-3 py-2 border border-gray-800/50">
                  {msg.content}
                </div>
              )}
            </div>
          ))}

          {loading && (
            <div className="text-sm text-gray-500 animate-pulse">
              Thinking...
            </div>
          )}
        </div>

        {/* Input */}
        <form onSubmit={handleSubmit} className="border-t border-gray-800 px-4 py-3">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about your fleet..."
            disabled={loading}
            className="w-full rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-blue-600 focus:outline-none disabled:opacity-50"
          />
        </form>
      </div>
    </div>
  );
}
