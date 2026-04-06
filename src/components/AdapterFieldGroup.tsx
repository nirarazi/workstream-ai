import type { JSX } from "react";
import type { SetupField } from "../lib/api";

interface AdapterFieldGroupProps {
  fields: SetupField[];
  values: Record<string, string>;
  envFields: Record<string, boolean>;
  onChange: (key: string, value: string) => void;
}

function FromEnvBadge() {
  return (
    <span className="ml-2 rounded bg-green-900/50 px-1.5 py-0.5 text-[10px] font-medium text-green-400">
      from env
    </span>
  );
}

const inputClass =
  "w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-gray-500";

export default function AdapterFieldGroup({
  fields,
  values,
  envFields,
  onChange,
}: AdapterFieldGroupProps): JSX.Element {
  return (
    <div className="space-y-3">
      {fields.map((field) => (
        <div key={field.key}>
          <label
            htmlFor={`adapter-${field.key}`}
            className="flex items-center text-xs text-gray-400 mb-1"
          >
            {field.label}
            {field.required && " *"}
            {envFields[field.key] && <FromEnvBadge />}
          </label>
          <input
            id={`adapter-${field.key}`}
            type={field.type}
            value={values[field.key] ?? ""}
            onChange={(e) => onChange(field.key, e.target.value)}
            placeholder={field.placeholder}
            className={inputClass}
          />
          {field.helpText && (
            <p className="mt-1 text-[11px] text-gray-600">{field.helpText}</p>
          )}
        </div>
      ))}
    </div>
  );
}
