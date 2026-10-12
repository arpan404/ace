import type { InteractionRequest } from "@ace/protocol";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input, fieldClassName } from "@/components/ui/input.tsx";
import type { Answer } from "./answer.ts";
import { consentUrl, elicitationContent, elicitationForm } from "./elicitation-schema.ts";

type Request = Extract<InteractionRequest, { kind: "elicitation" }>;

/** Forms send typed values; URL requests require an explicit safe consent action. */
export function Elicitation(props: { request: Request; disabled: boolean; onAnswer: Answer }) {
  const id = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const { request, disabled, onAnswer } = props;
  const mode = request.mode ?? (request.url ? "url" : "form");
  const form = mode === "form" ? elicitationForm(request.schema) : undefined;
  const result = form ? elicitationContent(form, values) : undefined;
  const url = mode === "url" ? consentUrl(request.url) : undefined;
  const unsupported = mode === "url" ? !url : !form;
  const change = (key: string, value: string) => {
    setValues((previous) => ({ ...previous, [key]: value }));
    setTouched((previous) => new Set([...previous, key]));
  };
  return (
    <form
      className="mt-3.5 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || unsupported || (result && !result.valid)) return;
        onAnswer({
          kind: "elicitation",
          action: "accept",
          ...(result ? { content: result.content } : {}),
        });
      }}
    >
      {unsupported && (
        <p role="alert" className="text-ui text-status-failed">
          {mode === "url"
            ? "This request has no safe consent URL. Decline or cancel it."
            : "This form uses an unsupported schema. Decline or cancel it."}
        </p>
      )}
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-ui text-link underline"
        >
          Open consent page
        </a>
      )}
      {form &&
        Object.entries(form.properties).map(([key, property], index) => {
          const fieldId = `${id}-${index}`;
          const value =
            values[key] ?? (property.default === undefined ? "" : String(property.default));
          const choices =
            property.enum?.map((entry, choiceIndex) => ({
              value: String(entry),
              label: property.enumNames?.[choiceIndex] ?? String(entry),
            })) ??
            (property.type === "boolean"
              ? [
                  { value: "true", label: "Yes" },
                  { value: "false", label: "No" },
                ]
              : undefined);
          const error = touched.has(key) ? result?.errors.get(key) : undefined;
          const attributes = {
            id: fieldId,
            disabled,
            required: form.required.includes(key),
            "aria-invalid": !!error,
            "aria-describedby": property.description || error ? `${fieldId}-detail` : undefined,
          };
          return (
            <div key={key} className="space-y-1">
              <label htmlFor={fieldId} className="text-ui">
                {property.title ?? key}
              </label>
              {choices ? (
                <select
                  {...attributes}
                  className={`${fieldClassName} h-8`}
                  value={value}
                  onChange={(event) => change(key, event.target.value)}
                >
                  <option value="">Choose…</option>
                  {choices.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  {...attributes}
                  value={value}
                  type={property.type === "string" ? "text" : "number"}
                  min={property.minimum}
                  max={property.maximum}
                  minLength={property.minLength}
                  maxLength={property.maxLength}
                  step={property.type === "integer" ? 1 : "any"}
                  onChange={(event) => change(key, event.target.value)}
                />
              )}
              {(property.description || error) && (
                <p id={`${fieldId}-detail`} className="text-xs text-muted-foreground">
                  {error ?? property.description}
                </p>
              )}
            </div>
          );
        })}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={disabled || unsupported || (result !== undefined && !result.valid)}
        >
          Continue
        </Button>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          disabled={disabled}
          onClick={() => onAnswer({ kind: "elicitation", action: "decline" })}
        >
          Decline
        </Button>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          disabled={disabled}
          onClick={() => onAnswer({ kind: "elicitation", action: "cancel" })}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
