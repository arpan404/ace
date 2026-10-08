import { useRef, type FormEvent } from "react";
import { ProviderApiKey } from "@ace/protocol";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";

/** Keys live only in this password field until the CLI asks for the hand-off. */
export function ApiKeyStep(props: {
  name: string;
  disabled: boolean | undefined;
  onSubmit(key: string): void;
  onCancel(): void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!field.current) return;
    const parsed = ProviderApiKey.safeParse(field.current.value.trim());
    field.current.value = "";
    if (!parsed.success) return setError("Paste a valid API key and try again.");
    setError(undefined);
    props.onSubmit(parsed.data);
    parsed.data = "";
  };
  return (
    <form aria-label="Use API key" onSubmit={submit} className="flex flex-col gap-3">
      <label htmlFor="provider-api-key" className="font-medium">
        {props.name} API key
      </label>
      <p className="text-sm text-muted-foreground">
        The CLI saves your key. ace hands it over once and never saves it.
      </p>
      <Input
        id="provider-api-key"
        ref={field}
        type="password"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        maxLength={8192}
        disabled={props.disabled}
        aria-invalid={Boolean(error)}
      />
      {error && (
        <p role="alert" className="text-sm text-status-failed">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            if (field.current) field.current.value = "";
            props.onCancel();
          }}
        >
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={props.disabled}>
          Use key
        </Button>
      </div>
    </form>
  );
}
