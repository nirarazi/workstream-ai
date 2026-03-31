import { useState, type JSX, type FormEvent } from "react";
import { postSetup, type SetupConfig } from "../lib/api";

interface SetupProps {
  onComplete: () => void;
}

export default function Setup({ onComplete }: SetupProps): JSX.Element {
  const [form, setForm] = useState<SetupConfig>({
    slackToken: "",
    llmApiKey: "",
    llmBaseUrl: "https://api.anthropic.com",
    llmModel: "claude-sonnet-4-6",
    jiraToken: "",
    jiraBaseUrl: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(field: keyof SetupConfig, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.slackToken.trim() || !form.llmApiKey.trim()) {
      setError("Slack Token and LLM API Key are required.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const payload: SetupConfig = {
        slackToken: form.slackToken.trim(),
        llmApiKey: form.llmApiKey.trim(),
        llmBaseUrl: form.llmBaseUrl.trim() || "https://api.anthropic.com",
        llmModel: form.llmModel.trim() || "claude-sonnet-4-6",
      };
      if (form.jiraToken?.trim()) payload.jiraToken = form.jiraToken.trim();
      if (form.jiraBaseUrl?.trim()) payload.jiraBaseUrl = form.jiraBaseUrl.trim();

      await postSetup(payload);
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setSubmitting(false);
    }
  }

  const inputClass =
    "w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-gray-500";

  return (
    <div className="mx-auto max-w-md py-16 px-6">
      <h2 className="text-lg font-semibold text-gray-100 mb-1">Configure ATC</h2>
      <p className="text-xs text-gray-500 mb-6">
        Connect your messaging platform and LLM provider to get started.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Slack */}
        <fieldset className="space-y-3">
          <legend className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">
            Slack
          </legend>
          <div>
            <label htmlFor="slackToken" className="block text-xs text-gray-400 mb-1">
              Slack Token *
            </label>
            <input
              id="slackToken"
              type="password"
              value={form.slackToken}
              onChange={(e) => update("slackToken", e.target.value)}
              placeholder="xoxp-..."
              className={inputClass}
            />
          </div>
        </fieldset>

        {/* LLM */}
        <fieldset className="space-y-3">
          <legend className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">
            LLM Provider
          </legend>
          <div>
            <label htmlFor="llmApiKey" className="block text-xs text-gray-400 mb-1">
              API Key *
            </label>
            <input
              id="llmApiKey"
              type="password"
              value={form.llmApiKey}
              onChange={(e) => update("llmApiKey", e.target.value)}
              placeholder="sk-..."
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="llmBaseUrl" className="block text-xs text-gray-400 mb-1">
              Base URL
            </label>
            <input
              id="llmBaseUrl"
              type="text"
              value={form.llmBaseUrl}
              onChange={(e) => update("llmBaseUrl", e.target.value)}
              placeholder="https://api.anthropic.com"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="llmModel" className="block text-xs text-gray-400 mb-1">
              Model
            </label>
            <input
              id="llmModel"
              type="text"
              value={form.llmModel}
              onChange={(e) => update("llmModel", e.target.value)}
              placeholder="claude-sonnet-4-6"
              className={inputClass}
            />
          </div>
        </fieldset>

        {/* Jira */}
        <fieldset className="space-y-3">
          <legend className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">
            Jira (optional)
          </legend>
          <div>
            <label htmlFor="jiraToken" className="block text-xs text-gray-400 mb-1">
              Jira Token
            </label>
            <input
              id="jiraToken"
              type="password"
              value={form.jiraToken}
              onChange={(e) => update("jiraToken", e.target.value)}
              placeholder="Jira API token"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="jiraBaseUrl" className="block text-xs text-gray-400 mb-1">
              Jira Base URL
            </label>
            <input
              id="jiraBaseUrl"
              type="text"
              value={form.jiraBaseUrl}
              onChange={(e) => update("jiraBaseUrl", e.target.value)}
              placeholder="https://your-org.atlassian.net"
              className={inputClass}
            />
          </div>
        </fieldset>

        {error && (
          <p className="text-xs text-red-400">{error}</p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-950 hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? "Saving..." : "Save & Continue"}
        </button>
      </form>
    </div>
  );
}
