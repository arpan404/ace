import { useRef, useState, type FormEvent } from "react";
import { ProviderSignInCode } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";

/**
 * When the sign-in page can't reach the computer running ace (another device, a remote session),
 * it shows a code instead. It lives only in this field until it's handed to the CLI's prompt.
 */
export function PasteCodeStep(props: {
  name: string;
  disabled: boolean | undefined;
  onSubmit(code: string): void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!field.current) return;
    const parsed = ProviderSignInCode.safeParse(field.current.value.trim());
    field.current.value = "";
    if (!parsed.success) return setError("Copy the whole code from the page and paste it here.");
    setError(undefined);
    props.onSubmit(parsed.data);
  };
  return (
    <form aria-label="Paste sign-in code" onSubmit={submit} className="flex flex-col gap-2">
      <label htmlFor="provider-sign-in-code" className="text-sm font-medium">
        Got a code instead?
      </label>
      <p className="text-sm text-muted-foreground">
        If the page shows a code, paste it here. ace hands it to {props.name} and doesn't keep it.
      </p>
      <div className="flex gap-2">
        <Input
          id="provider-sign-in-code"
          ref={field}
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={4096}
          disabled={props.disabled}
          aria-invalid={Boolean(error)}
        />
        <Button type="submit" variant="secondary" disabled={props.disabled}>
          Continue
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-status-failed">
          {error}
        </p>
      )}
    </form>
  );
}
