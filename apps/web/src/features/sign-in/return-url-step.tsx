import { useRef, useState, type FormEvent } from "react";
import { ProviderSignInReturnUrl } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";

/**
 * Signing in on a device other than the computer running ace, the browser's last page (an
 * address on 127.0.0.1) can't load. Its address carries a one-time code; it lives only in this
 * field until it's handed to the agent waiting on that computer.
 */
export function ReturnUrlStep(props: {
  name: string;
  disabled: boolean | undefined;
  onSubmit(returnUrl: string): void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!field.current) return;
    const parsed = ProviderSignInReturnUrl.safeParse(field.current.value.trim());
    field.current.value = "";
    if (!parsed.success)
      return setError(
        "Copy the whole address, starting with http://127.0.0.1 or http://localhost.",
      );
    setError(undefined);
    props.onSubmit(parsed.data);
  };
  return (
    <form aria-label="Paste return address" onSubmit={submit} className="flex flex-col gap-2">
      <label htmlFor="provider-sign-in-return" className="text-sm font-medium">
        Page didn't load?
      </label>
      <p className="text-sm text-muted-foreground">
        Paste the address it ended on. ace hands it to {props.name} and doesn't keep it.
      </p>
      <div className="flex gap-2">
        <Input
          id="provider-sign-in-return"
          ref={field}
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={8192}
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
