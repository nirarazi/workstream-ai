import { useState, useEffect, type JSX, type FormEvent } from "react";
import {
  postSetup,
  fetchSetupPrefill,
  fetchSetupAdapters,
  openExternalUrl,
  type SetupPayload,
  type RateLimitInfo,
  type AdapterSetupInfo,
} from "../lib/api";
import AdapterFieldGroup from "./AdapterFieldGroup";

interface SetupProps {
  onComplete: () => void;
}

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

function openExternal(url: string) {
  openExternalUrl(url);
}

export default function Setup({ onComplete }: SetupProps): JSX.Element {
  // Adapter schemas from server
  const [messagingAdapters, setMessagingAdapters] = useState<AdapterSetupInfo[]>([]);
  const [taskAdapters, setTaskAdapters] = useState<AdapterSetupInfo[]>([]);

  // Selected adapter per category
  const [selectedMessaging, setSelectedMessaging] = useState<string>("");
  const [selectedTask, setSelectedTask] = useState<string>("");

  // Field values per adapter
  const [messagingFields, setMessagingFields] = useState<Record<string, string>>({});
  const [taskFields, setTaskFields] = useState<Record<string, string>>({});
  const [messagingEnv, setMessagingEnv] = useState<Record<string, boolean>>({});
  const [taskEnv, setTaskEnv] = useState<Record<string, boolean>>({});

  // LLM fields
  const [llmApiKey, setLlmApiKey] = useState("");
  const [llmBaseUrl, setLlmBaseUrl] = useState(PRESETS.anthropic.baseUrl);
  const [llmModel, setLlmModel] = useState(PRESETS.anthropic.models[0]);
  const [preset, setPreset] = useState<ProviderPreset>("anthropic");
  const [llmEnv, setLlmEnv] = useState<Record<string, boolean>>({});

  // LLM Budget
  const [dailyBudget, setDailyBudget] = useState<string>("");
  const [inputCostPerMillion, setInputCostPerMillion] = useState<string>("");
  const [outputCostPerMillion, setOutputCostPerMillion] = useState<string>("");

  // Rate limits
  const [rateLimits, setRateLimits] = useState<Record<string, RateLimitInfo>>({});

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch adapter schemas + prefill on mount
  useEffect(() => {
    Promise.all([fetchSetupAdapters(), fetchSetupPrefill()])
      .then(([adapters, prefill]) => {
        setMessagingAdapters(adapters.messaging);
        setTaskAdapters(adapters.task);

        const defaultMessaging = prefill.messaging?.adapter ?? adapters.messaging[0]?.name ?? "";
        const defaultTask = prefill.task?.adapter ?? adapters.task[0]?.name ?? "";
        setSelectedMessaging(defaultMessaging);
        setSelectedTask(defaultTask);

        if (prefill.messaging?.fields) {
          setMessagingFields(prefill.messaging.fields);
          const env: Record<string, boolean> = {};
          for (const key of Object.keys(prefill.messaging.fields)) {
            if (prefill.messaging.fields[key]) env[key] = true;
          }
          setMessagingEnv(env);
        }

        if (prefill.task?.fields) {
          setTaskFields(prefill.task.fields);
          const env: Record<string, boolean> = {};
          for (const key of Object.keys(prefill.task.fields)) {
            if (prefill.task.fields[key]) env[key] = true;
          }
          setTaskEnv(env);
        }

        if (prefill.llm) {
          const envDetected: Record<string, boolean> = {};
          if (prefill.llm.apiKey) {
            setLlmApiKey(prefill.llm.apiKey);
            envDetected.apiKey = true;
          }
          if (prefill.llm.baseUrl) {
            setLlmBaseUrl(prefill.llm.baseUrl);
            envDetected.baseUrl = true;
            for (const [id, p] of Object.entries(PRESETS) as [ProviderPreset, typeof PRESETS[ProviderPreset]][]) {
              if (p.baseUrl && prefill.llm.baseUrl.startsWith(p.baseUrl.replace("/v1", ""))) {
                setPreset(id);
                break;
              }
            }
          }
          if (prefill.llm.model) {
            setLlmModel(prefill.llm.model);
            envDetected.model = true;
          }
          if (prefill.llm.dailyBudget != null) setDailyBudget(String(prefill.llm.dailyBudget));
          if (prefill.llm.inputCostPerMillion != null) setInputCostPerMillion(String(prefill.llm.inputCostPerMillion));
          if (prefill.llm.outputCostPerMillion != null) setOutputCostPerMillion(String(prefill.llm.outputCostPerMillion));
          setLlmEnv(envDetected);
        }

        if (prefill.rateLimits) {
          setRateLimits(prefill.rateLimits);
        }
      })
      .catch(() => {});
  }, []);

  const currentMessaging = messagingAdapters.find((a) => a.name === selectedMessaging);
  const currentTask = taskAdapters.find((a) => a.name === selectedTask);
  const currentPreset = PRESETS[preset];

  function updateMessagingField(key: string, value: string) {
    setMessagingFields((prev) => ({ ...prev, [key]: value }));
    setMessagingEnv((prev) => ({ ...prev, [key]: false }));
  }

  function updateTaskField(key: string, value: string) {
    setTaskFields((prev) => ({ ...prev, [key]: value }));
    setTaskEnv((prev) => ({ ...prev, [key]: false }));
  }

  function applyPreset(id: ProviderPreset) {
    setPreset(id);
    const p = PRESETS[id];
    setLlmBaseUrl(p.baseUrl || llmBaseUrl);
    setLlmModel(p.models[0] ?? llmModel);
    if (!p.needsKey) setLlmApiKey("(not required)");
    setLlmEnv({});
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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (currentMessaging) {
      for (const field of currentMessaging.fields) {
        if (field.required && !messagingFields[field.key]?.trim()) {
          setError(`${currentMessaging.displayName}: ${field.label} is required.`);
          return;
        }
      }
    }

    const needsKey = currentPreset.needsKey;
    const keyValue = llmApiKey === "(not required)" ? "" : llmApiKey;
    if (needsKey && !keyValue.trim()) {
      setError("LLM API Key is required.");
      return;
    }

    setSubmitting(true);
    try {
      const payload: SetupPayload = {};

      if (selectedMessaging && currentMessaging) {
        const fields: Record<string, string> = {};
        for (const field of currentMessaging.fields) {
          const val = messagingFields[field.key]?.trim();
          if (val) fields[field.key] = val;
        }
        if (Object.keys(fields).length > 0) {
          payload.messaging = { adapter: selectedMessaging, fields };
        }
      }

      if (selectedTask && currentTask) {
        const fields: Record<string, string> = {};
        let hasValues = false;
        for (const field of currentTask.fields) {
          const val = taskFields[field.key]?.trim();
          if (val) {
            fields[field.key] = val;
            hasValues = true;
          }
        }
        if (hasValues) {
          payload.task = { adapter: selectedTask, fields };
        }
      }

      payload.llm = {
        apiKey: keyValue.trim(),
        baseUrl: llmBaseUrl.trim() || PRESETS.anthropic.baseUrl,
        model: llmModel.trim() || PRESETS.anthropic.models[0],
        dailyBudget: dailyBudget ? parseFloat(dailyBudget) : null,
        inputCostPerMillion: inputCostPerMillion ? parseFloat(inputCostPerMillion) : null,
        outputCostPerMillion: outputCostPerMillion ? parseFloat(outputCostPerMillion) : null,
      };

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

  const apiKeyLink: Record<string, string> = {
    anthropic: "https://console.anthropic.com/settings/keys",
    openai: "https://platform.openai.com/api-keys",
    openrouter: "https://openrouter.ai/keys",
    ollama: "https://ollama.com",
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
        {/* ── Messaging ─────────────────────────────────────── */}
        {messagingAdapters.length > 0 && (
          <fieldset className="space-y-3">
            <div className="flex items-center justify-between mb-1">
              <legend className="text-xs font-semibold uppercase tracking-widest text-gray-500">
                {messagingAdapters.length === 1
                  ? messagingAdapters[0].displayName
                  : "Messaging"}
              </legend>
              {currentMessaging?.helpUrl && (
                <button
                  type="button"
                  onClick={() => openExternal(currentMessaging.helpUrl!)}
                  className="text-[11px] text-blue-400 hover:text-blue-300"
                >
                  Get token →
                </button>
              )}
            </div>

            {messagingAdapters.length > 1 && (
              <div className="flex gap-1.5">
                {messagingAdapters.map((a) => (
                  <button
                    key={a.name}
                    type="button"
                    onClick={() => {
                      setSelectedMessaging(a.name);
                      setMessagingFields({});
                      setMessagingEnv({});
                    }}
                    className={`flex-1 rounded border py-1.5 text-xs font-medium transition-colors ${
                      selectedMessaging === a.name
                        ? "border-blue-500 bg-blue-900/40 text-blue-300"
                        : "border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-400"
                    }`}
                  >
                    {a.displayName}
                  </button>
                ))}
              </div>
            )}

            {currentMessaging && (
              <AdapterFieldGroup
                fields={currentMessaging.fields}
                values={messagingFields}
                envFields={messagingEnv}
                onChange={updateMessagingField}
              />
            )}
          </fieldset>
        )}

        {/* ── LLM Provider ──────────────────────────────────── */}
        <fieldset className="space-y-3">
          <div className="flex items-center justify-between mb-1">
            <legend className="text-xs font-semibold uppercase tracking-widest text-gray-500">
              {currentPreset.label}
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

          {currentPreset.needsKey && (
            <div>
              <label htmlFor="llmApiKey" className="flex items-center text-xs text-gray-400 mb-1">
                API Key *
                {llmEnv.apiKey && (
                  <span className="ml-2 rounded bg-green-900/50 px-1.5 py-0.5 text-[10px] font-medium text-green-400">
                    from env
                  </span>
                )}
              </label>
              <input
                id="llmApiKey"
                type="password"
                value={llmApiKey}
                onChange={(e) => { setLlmApiKey(e.target.value); setLlmEnv((p) => ({ ...p, apiKey: false })); }}
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

          <div>
            <label htmlFor="llmModel" className="flex items-center text-xs text-gray-400 mb-1">
              Model
              {llmEnv.model && (
                <span className="ml-2 rounded bg-green-900/50 px-1.5 py-0.5 text-[10px] font-medium text-green-400">
                  from env
                </span>
              )}
            </label>
            {currentPreset.models.length > 0 ? (
              <select
                id="llmModel"
                value={llmModel}
                onChange={(e) => { setLlmModel(e.target.value); setLlmEnv((p) => ({ ...p, model: false })); }}
                className={selectClass}
              >
                {currentPreset.models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
                <option value="custom">Custom…</option>
              </select>
            ) : (
              <input
                id="llmModel"
                type="text"
                value={llmModel}
                onChange={(e) => { setLlmModel(e.target.value); setLlmEnv((p) => ({ ...p, model: false })); }}
                placeholder="model name"
                className={inputClass}
              />
            )}
            {currentPreset.models.length > 0 && llmModel === "custom" && (
              <input
                type="text"
                value=""
                onChange={(e) => setLlmModel(e.target.value)}
                placeholder="Enter model name"
                className={`${inputClass} mt-1.5`}
                autoFocus
              />
            )}
          </div>

          {(preset === "custom" || preset === "ollama") && (
            <div>
              <label htmlFor="llmBaseUrl" className="flex items-center text-xs text-gray-400 mb-1">
                Base URL
                {llmEnv.baseUrl && (
                  <span className="ml-2 rounded bg-green-900/50 px-1.5 py-0.5 text-[10px] font-medium text-green-400">
                    from env
                  </span>
                )}
              </label>
              <input
                id="llmBaseUrl"
                type="text"
                value={llmBaseUrl}
                onChange={(e) => { setLlmBaseUrl(e.target.value); setLlmEnv((p) => ({ ...p, baseUrl: false })); }}
                placeholder="http://localhost:11434/v1"
                className={inputClass}
              />
            </div>
          )}

          {/* ── Budget (optional) ─── */}
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label htmlFor="dailyBudget" className="text-xs text-gray-400 mb-1 block">
                Daily Budget ($)
              </label>
              <input
                id="dailyBudget"
                type="number"
                step="0.01"
                min="0"
                value={dailyBudget}
                onChange={(e) => setDailyBudget(e.target.value)}
                placeholder="20.00"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="inputCost" className="text-xs text-gray-400 mb-1 block">
                Input $/1M tok
              </label>
              <input
                id="inputCost"
                type="number"
                step="0.01"
                min="0"
                value={inputCostPerMillion}
                onChange={(e) => setInputCostPerMillion(e.target.value)}
                placeholder="3.00"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="outputCost" className="text-xs text-gray-400 mb-1 block">
                Output $/1M tok
              </label>
              <input
                id="outputCost"
                type="number"
                step="0.01"
                min="0"
                value={outputCostPerMillion}
                onChange={(e) => setOutputCostPerMillion(e.target.value)}
                placeholder="15.00"
                className={inputClass}
              />
            </div>
          </div>
          <p className="text-[11px] text-gray-600">
            Leave empty if your API returns cost data, or if you don't need cost tracking.
          </p>
        </fieldset>

        {/* ── Task Adapter (optional) ──────────────────────── */}
        {taskAdapters.length > 0 && (
          <fieldset className="space-y-3">
            <div className="flex items-center justify-between mb-1">
              <legend className="text-xs font-semibold uppercase tracking-widest text-gray-500">
                {taskAdapters.length === 1
                  ? taskAdapters[0].displayName
                  : "Task Manager"}{" "}
                <span className="normal-case text-gray-600">(optional)</span>
              </legend>
              {currentTask?.helpUrl && (
                <button
                  type="button"
                  onClick={() => openExternal(currentTask.helpUrl!)}
                  className="text-[11px] text-blue-400 hover:text-blue-300"
                >
                  Get token →
                </button>
              )}
            </div>

            {taskAdapters.length > 1 && (
              <div className="flex gap-1.5">
                {taskAdapters.map((a) => (
                  <button
                    key={a.name}
                    type="button"
                    onClick={() => {
                      setSelectedTask(a.name);
                      setTaskFields({});
                      setTaskEnv({});
                    }}
                    className={`flex-1 rounded border py-1.5 text-xs font-medium transition-colors ${
                      selectedTask === a.name
                        ? "border-blue-500 bg-blue-900/40 text-blue-300"
                        : "border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-400"
                    }`}
                  >
                    {a.displayName}
                  </button>
                ))}
              </div>
            )}

            {currentTask && (
              <AdapterFieldGroup
                fields={currentTask.fields}
                values={taskFields}
                envFields={taskEnv}
                onChange={updateTaskField}
              />
            )}
          </fieldset>
        )}

        {/* ── Rate Limits (dynamic) ─────────────────────────── */}
        {rateLimitEntries.length > 0 && (
          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1">
              Rate Limits{" "}
              <span className="normal-case text-gray-600">(requests/min)</span>
            </legend>
            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(rateLimitEntries.length, 4)}, minmax(0, 1fr))` }}>
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
