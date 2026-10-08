import { ApiKeyUpstream, type ProviderKind } from "@ace/protocol";
import { PlusIcon } from "@phosphor-icons/react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { preloadSignIn, useSignIn } from "@/features/sign-in/index.ts";
import {
  apiKeyUpstreamLabel,
  canAddAccounts,
  useAccountActions,
  useApiKeySupport,
} from "./account-actions.ts";

/**
 * The last row: Add account. It asks only for a name, adds the account and opens its sign-in
 * at once, so there is no separate page for it.
 */
export function AddAccount(props: { provider: ProviderKind; name: string }) {
  const signIn = useSignIn();
  const actions = useAccountActions();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const provider = props.provider;
  const support = useApiKeySupport(provider);
  const [method, setMethod] = useState<"login" | "api_key">("login");
  const [upstream, setUpstream] = useState<"openai" | "anthropic" | "openrouter" | "opencode">(
    "openai",
  );
  if (!signIn || !canAddAccounts(provider)) return null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = label.trim();
    if (!name) return setError("Give the account a name, like Work.");
    setBusy(true);
    setError(undefined);
    try {
      const instance = await actions.add(provider, name);
      setOpen(false);
      setLabel("");
      signIn({
        provider,
        instance,
        method,
        ...(method === "api_key" && provider === "opencode" ? { upstream } : {}),
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't add the account.");
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <li>
        <button
          type="button"
          onPointerEnter={() => void preloadSignIn()}
          onClick={() => setOpen(true)}
          className="flex min-h-8 w-full items-center gap-2 py-1 text-left text-muted-foreground transition-colors duration-(--dur-1) focus-ring-inset hover:bg-accent hover:text-foreground"
        >
          <span className="grid size-4 place-items-center">
            <PlusIcon aria-hidden size={14} />
          </span>
          <span className="font-medium">Add account</span>
        </button>
      </li>
    );
  return (
    <li className="fx-rise-in px-4 py-3">
      <form
        aria-label="Add account"
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-2"
      >
        <label htmlFor="add-account-name" className="font-medium">
          Add a {props.name} account
        </label>
        <p className="text-sm text-muted-foreground">
          Name it, then sign in. ace keeps it separate from your other {props.name} sign-ins.
        </p>
        {support.data?.supported && (
          <div className="flex flex-wrap items-center gap-2">
            <Select<"login" | "api_key">
              label="Sign-in method"
              value={method}
              options={[
                { value: "login", label: "Browser sign-in" },
                { value: "api_key", label: "API key" },
              ]}
              onValueChange={setMethod}
            />
            {method === "api_key" && provider === "opencode" && (
              <Select<"openai" | "anthropic" | "openrouter" | "opencode">
                label="API service"
                value={upstream}
                options={(support.data.upstreams ?? []).flatMap((value) => {
                  const parsed = ApiKeyUpstream.safeParse(value);
                  return parsed.success
                    ? [
                        {
                          value: parsed.data,
                          label: apiKeyUpstreamLabel(parsed.data),
                        },
                      ]
                    : [];
                })}
                onValueChange={setUpstream}
              />
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="add-account-name"
            autoFocus
            placeholder="Work"
            value={label}
            maxLength={128}
            aria-invalid={error !== undefined}
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
            }}
            className="max-w-64 flex-1"
          />
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Adding…" : "Add and sign in"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-status-failed">
            {error}
          </p>
        )}
      </form>
    </li>
  );
}
