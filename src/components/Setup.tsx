import { useState, useEffect, type JSX, type FormEvent } from "react";
import { postSetup, fetchSetupPrefill, openExternalUrl, type SetupConfig, type RateLimitInfo } from "../lib/api";

interface SetupProps {
  onComplete: () => void;
}

// --- Provider presets ---

type ProviderPreset = "anthropic" | "openai" | "openrouter" | "ollama" | "custom";

const PRESETS: Record<
  ProviderPreset,
  { label: string; baseUrl: string; models: string[]; needsKey: boolean }
> = {
  anthropic: {
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    models: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5-20251001"],
    needsKey: true,
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
    needsKey: true,
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      "openrouter/auto",
      "openrouter/free",
      "anthropic/claude-sonnet-4",
      "anthropic/claude-haiku-4",
      "google/gemini-2.5-pro-preview",
      "google/gemini-2.5-flash-preview",
      "openai/gpt-4o",
      "meta-llama/llama-4-maverick",
      "deepseek/deepseek-r1",
    ],
    needsKey: true,
  },
  ollama: {
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    models: ["llama3", "mistral", "qwen2.5"],
    needsKey: false,
  },
  custom: {
    label: "Custom",
    baseUrl: "",
    models: [],
    needsKey: true,
  },
};

// --- Helper link opener ---
function openExternal(url: string) {
  openExternalUrl(url);
}

// --- Env-prefilled badge ---
function FromEnvBadge() {
  return (
    <span className="ml-2 rounded bg-green-900/50 px-1.5 py-0.5 text-[10px] font-medium text-green-400">
      from env
    </span>
  );
}

export default function Setup({ onComplete }: SetupProps): JSX.Element {
  const [form, setForm] = useState<SetupConfig>({
    slackToken: "",
    llmApiKey: "",
    llmBaseUrl: PRESETS.anthropic.baseUrl,
    llmModel: PRESETS.anthropic.models[0],
    jiraEmail: "",
    jiraToken: "",
    jiraBaseUrl: "",
  });
  const [rateLimits, setRateLimits] = useState<Record<string, RateLimitInfo>>({});
  const [envFields, setEnvFields] = useState<Partial<Record<keyof SetupConfig, boolean>>>({});
  const [preset, setPreset] = useState<ProviderPreset>("anthropic");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-populate from env vars on mount
  useEffect(() => {
    fetchSetupPrefill()
      .then((prefill) => {
        const detected: Partial<Record<keyof SetupConfig, boolean>> = {};
        setForm((prev) => {
          const next = { ...prev };
          for (const key of Object.keys(prefill) as (keyof SetupConfig)[]) {
            if (key === "rateLimits") continue;
            const val = prefill[key];
            if (val) {
              (next as Record<string, string>)[key] = val as string;
              detected[key] = true;
            }
          }
          return next;
        });
        setEnvFields(detected);

        // Populate rate limits from server
        if (prefill.rateLimits && typeof prefill.rateLimits === "object") {
          setRateLimits(prefill.rateLimits);
        }

        // Detect preset from prefilled base URL
        if (prefill.llmBaseUrl) {
          for (const [id, p] of Object.entries(PRESETS) as [ProviderPreset, typeof PRESETS[ProviderPreset]][]) {
            if (p.baseUrl && (prefill.llmBaseUrl as string).startsWith(p.baseUrl.replace("/v1", ""))) {
              setPreset(id);
              break;
            }
          }
        }
      })
      .catch(() => {/* prefill is best-effort */});
  }, []);

  function update(field: keyof SetupConfig, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    // Clear env badge if user edits the field
    setEnvFields((prev) => ({ ...prev, [field]: false }));
  }

  function updateRateLimit(name: string, value: string) {
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed) && parsed > 0) {
      setRateLimits((prev) => ({
        ...prev,
        [name]: { ...prev[name], maxPerMinute: parsed },
      }));
    }
  }

  function applyPreset(id: ProviderPreset) {
    setPreset(id);
    const p = PRESETS[id];
    setForm((prev) => ({
      ...prev,
      llmBaseUrl: p.baseUrl || prev.llmBaseUrl,
      llmModel: p.models[0] ?? prev.llmModel,
      llmApiKey: p.needsKey ? prev.llmApiKey : "(not required)",
    }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const needsKey = PRESETS[preset].needsKey;
    const keyValue = form.llmApiKey === "(not required)" ? "" : form.llmApiKey;
    if (!form.slackToken.trim() || (needsKey && !keyValue.trim())) {
      setError(
        needsKey
          ? "Slack Token and LLM API Key are required."
          : "Slack Token is required.",
      );
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const payload: SetupConfig = {
        slackToken: form.slackToken.trim(),
        llmApiKey: keyValue.trim(),
        llmBaseUrl: form.llmBaseUrl.trim() || PRESETS.anthropic.baseUrl,
        llmModel: form.llmModel.trim() || PRESETS.anthropic.models[0],
      };
      if (form.jiraEmail?.trim()) payload.jiraEmail = form.jiraEmail.trim();
      if (form.jiraToken?.trim()) payload.jiraToken = form.jiraToken.trim();
      if (form.jiraBaseUrl?.trim()) payload.jiraBaseUrl = form.jiraBaseUrl.trim();
      if (Object.keys(rateLimits).length > 0) {
        const rl: Record<string, number> = {};
        for (const [name, info] of Object.entries(rateLimits)) {
          rl[name] = info.maxPerMinute;
        }
        payload.rateLimits = rl;
      }

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
  const selectClass =
    "w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 outline-none focus:border-gray-500";

  const slackTokenLink = "https://api.slack.com/apps";
  const jiraTokenLink = "https://id.atlassian.com/manage-profile/security/api-tokens";
  const anthropicKeyLink = "https://console.anthropic.com/settings/keys";
  const openaiKeyLink = "https://platform.openai.com/api-keys";
  const openrouterKeyLink = "https://openrouter.ai/keys";
  const ollamaLink = "https://ollama.com";

  const currentPreset = PRESETS[preset];
  const apiKeyLink: Record<string, string> = {
    anthropic: anthropicKeyLink,
    openai: openaiKeyLink,
    openrouter: openrouterKeyLink,
    ollama: ollamaLink,
  };
  const currentKeyLink = apiKeyLink[preset] ?? null;

  const rateLimitEntries = Object.entries(rateLimits).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="mx-auto max-w-md py-10 px-6">
      <h2 className="text-lg font-semibold text-gray-100 mb-1">Configure ATC</h2>
      <p className="text-xs text-gray-500 mb-6">
        Connect your messaging platform and LLM provider to get started.
      </p>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* ── Slack ─────────────────────────────────────────── */}
        <fieldset className="space-y-3">
          <div className="flex items-center justify-between mb-1">
            <legend className="text-xs font-semibold uppercase tracking-widest text-gray-500">
              Slack
            </legend>
            <button
              type="button"
              onClick={() => openExternal(slackTokenLink)}
              className="text-[11px] text-blue-400 hover:text-blue-300"
            >
              Get token →
            </button>
          </div>
          <div>
            <label htmlFor="slackToken" className="flex items-center text-xs text-gray-400 mb-1">
              Slack Token *
              {envFields.slackToken && <FromEnvBadge />}
            </label>
            <input
              id="slackToken"
              type="password"
              value={form.slackToken}
              onChange={(e) => update("slackToken", e.target.value)}
              placeholder="xoxp-..."
              className={inputClass}
            />
            <p className="mt-1 text-[11px] text-gray-600">
              Needs scopes: channels:history, channels:read, chat:write, users:read
            </p>
          </div>
        </fieldset>

        {/* ── LLM Provider ──────────────────────────────────── */}
        <fieldset className="space-y-3">
          <div className="flex items-center justify-between mb-1">
            <legend className="text-xs font-semibold uppercase tracking-widest text-gray-500">
              LLM Provider
            </legend>
            {currentKeyLink && (
              <button
                type="button"
                onClick={() => openExternal(currentKeyLink)}
                className="text-[11px] text-blue-400 hover:text-blue-300"
              >
                {preset === "ollama" ? "Get Ollama →" : "Get API key →"}
              </button>
            )}
          </div>

          {/* Provider selector */}
          <div className="flex gap-1.5">
            {(Object.keys(PRESETS) as ProviderPreset[]).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => applyPreset(id)}
                className={`flex-1 rounded border py-1.5 text-xs font-medium transition-colors ${
                  preset === id
                    ? "border-blue-500 bg-blue-900/40 text-blue-300"
                    : "border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-400"
                }`}
              >
                {PRESETS[id].label}
              </button>
            ))}
          </div>

          {/* API Key — hidden for Ollama */}
          {currentPreset.needsKey && (
            <div>
              <label htmlFor="llmApiKey" className="flex items-center text-xs text-gray-400 mb-1">
                API Key *
                {envFields.llmApiKey && <FromEnvBadge />}
              </label>
              <input
                id="llmApiKey"
                type="password"
                value={form.llmApiKey}
                onChange={(e) => update("llmApiKey", e.target.value)}
                placeholder={preset === "anthropic" ? "sk-ant-..." : "sk-..."}
                className={inputClass}
              />
            </div>
          )}
          {!currentPreset.needsKey && (
            <p className="text-[11px] text-green-500">
              No API key required — Ollama runs locally.
            </p>
          )}

          {/* Model selector */}
          <div>
            <label htmlFor="llmModel" className="flex items-center text-xs text-gray-400 mb-1">
              Model
              {envFields.llmModel && <FromEnvBadge />}
            </label>
            {currentPreset.models.length > 0 ? (
              <select
                id="llmModel"
                value={form.llmModel}
                onChange={(e) => update("llmModel", e.target.value)}
                className={selectClass}
              >
                {currentPreset.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
            ) : (
              <input
                id="llmModel"
                type="text"
                value={form.llmModel}
                onChange={(e) => update("llmModel", e.target.value)}
                placeholder="model name"
                className={inputClass}
              />
            )}
            {/* Custom model text input when "custom" is selected in preset dropdown */}
            {currentPreset.models.length > 0 && form.llmModel === "custom" && (
              <input
                type="text"
                value=""
                onChange={(e) => update("llmModel", e.target.value)}
                placeholder="Enter model name"
                className={`${inputClass} mt-1.5`}
                autoFocus
              />
            )}
          </div>

          {/* Base URL — only shown for custom or if user wants to override */}
          {(preset === "custom" || preset === "ollama") && (
            <div>
              <label htmlFor="llmBaseUrl" className="flex items-center text-xs text-gray-400 mb-1">
                Base URL
                {envFields.llmBaseUrl && <FromEnvBadge />}
              </label>
              <input
                id="llmBaseUrl"
                type="text"
                value={form.llmBaseUrl}
                onChange={(e) => update("llmBaseUrl", e.target.value)}
                placeholder="http://localhost:11434/v1"
                className={inputClass}
              />
            </div>
          )}
        </fieldset>

        {/* ── Jira (optional) ───────────────────────────────── */}
        <fieldset className="space-y-3">
          <div className="flex items-center justify-between mb-1">
            <legend className="text-xs font-semibold uppercase tracking-widest text-gray-500">
              Jira{" "}
              <span className="normal-case text-gray-600">(optional)</span>
            </legend>
            <button
              type="button"
              onClick={() => openExternal(jiraTokenLink)}
              className="text-[11px] text-blue-400 hover:text-blue-300"
            >
              Get token →
            </button>
          </div>
          <div>
            <label htmlFor="jiraEmail" className="flex items-center text-xs text-gray-400 mb-1">
              Jira Email
            </label>
            <input
              id="jiraEmail"
              type="email"
              value={form.jiraEmail}
              onChange={(e) => update("jiraEmail", e.target.value)}
              placeholder="you@company.com"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="jiraToken" className="flex items-center text-xs text-gray-400 mb-1">
              Jira API Token
              {envFields.jiraToken && <FromEnvBadge />}
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
            <label htmlFor="jiraBaseUrl" className="flex items-center text-xs text-gray-400 mb-1">
              Jira Base URL
              {envFields.jiraBaseUrl && <FromEnvBadge />}
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

        {/* ── Rate Limits (dynamic) ─────────────────────────── */}
        {rateLimitEntries.length > 0 && (
          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1">
              Rate Limits{" "}
              <span className="normal-case text-gray-600">(requests/min)</span>
            </legend>
            <div className={`grid gap-3`} style={{ gridTemplateColumns: `repeat(${Math.min(rateLimitEntries.length, 4)}, minmax(0, 1fr))` }}>
              {rateLimitEntries.map(([name, info]) => (
                <div key={name}>
                  <label htmlFor={`rl-${name}`} className="text-xs text-gray-400 mb-1 block">
                    {info.displayName}
                  </label>
                  <input
                    id={`rl-${name}`}
                    type="number"
                    min={1}
                    max={200}
                    value={info.maxPerMinute}
                    onChange={(e) => updateRateLimit(name, e.target.value)}
                    className={inputClass}
                  />
                </div>
              ))}
            </div>
            <p className="text-[11px] text-gray-600">
              Lower values reduce API load; raise if you see frequent throttling.
            </p>
          </fieldset>
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-950 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? "Saving..." : "Save & Continue"}
        </button>
      </form>
    </div>
  );
}
