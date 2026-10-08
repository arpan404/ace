import { ApiKeyUpstream, type ProviderKind } from "@ace/protocol";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useInlineSignIn, useSignIn } from "@/features/sign-in/index.ts";
import { apiKeyUpstreamLabel, canAddAccounts, useApiKeySupport } from "./actions.ts";

/**
 * The last row: Add account. It asks only for a name, adds the account and opens its sign-in
 * at once, so there is no separate page for it.
 */
export function AddAccountForm(props: { provider: ProviderKind; name: string; onClose(): void }) {
  const nameId = useId();
  const signIn = useSignIn();
  const keyLogin = useInlineSignIn({ onClose: props.onClose });
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string>();
  const provider = props.provider;
  const support = useApiKeySupport(provider);
  const [method, setMethod] = useState<"login" | "api_key">("login");
  const [upstream, setUpstream] = useState<"openai" | "anthropic" | "openrouter" | "opencode">(
    "openai",
  );
  if (!signIn || !canAddAccounts(provider)) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = label.trim();
    if (!name) return setError("Give the account a name, like Work.");
    setError(undefined);
    try {
      setLabel("");
      const login = method === "api_key" ? keyLogin.start : signIn;
      login({
        provider,
        newAccount: name,
        method,
        ...(method === "api_key" && provider === "opencode" ? { upstream } : {}),
      });
      if (method !== "api_key") props.onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't add the account.");
    }
  };
  if (keyLogin.active) return <>{keyLogin.content}</>;
  return (
    <div>
      <form
        aria-label="Add account"
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-2"
      >
        <label htmlFor={nameId} className="font-medium">
          Add {props.provider === "opencode" ? "an" : "a"} {props.name} account
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
            id={nameId}
            autoFocus
            placeholder="Work"
            value={label}
            maxLength={128}
            aria-invalid={error !== undefined}
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") props.onClose();
            }}
            className="max-w-64 flex-1"
          />
          <Button type="submit" variant="primary">
            Add and sign in
          </Button>
          <Button type="button" variant="ghost" onClick={() => props.onClose()}>
            Cancel
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-status-failed">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
