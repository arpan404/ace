import { useToast } from "@/components/ui/toast.tsx";
import { accountBadge } from "@/components/ui/account-badge.ts";
import { AccountBadgeChooser, accountBadgeProblem } from "@/components/ui/account-badge-field.tsx";
import { AccountBadgeColor } from "@ace/protocol/accounts";
import { useNavigate } from "@tanstack/react-router";
import { serviceInfo } from "@ace/ui-core";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { ApiKeyUpstream, type ProviderKind } from "@ace/protocol";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useInlineSignIn } from "@/features/sign-in/index.ts";
import {
  apiKeyUpstreamLabel,
  canAddAccounts,
  useApiKeySupport,
  useAccountActions,
} from "./actions.ts";

const apiServices = ApiKeyUpstream.options.map((value) => ({
  value,
  label: apiKeyUpstreamLabel(value),
  icon: (
    <ProviderIcon
      provider="opencode"
      brand={serviceInfo(value).brand}
      size={16}
      label={apiKeyUpstreamLabel(value)}
    />
  ),
}));

/**
 * The last row: Add account. It asks only for a name, adds the account and opens its sign-in
 * at once, so there is no separate page for it.
 */
export function AddAccountForm(props: { provider: ProviderKind; name: string; onClose(): void }) {
  const nameId = useId();

  const [label, setLabel] = useState("");
  const [badge, setBadge] = useState("");
  const [color, setColor] = useState<AccountBadgeColor>("violet");
  const actions = useAccountActions();
  const toast = useToast();
  const navigate = useNavigate();
  const keyLogin = useInlineSignIn({
    onClose: props.onClose,
    onSuccess: async (progress) => {
      if (!progress.instance) return;
      await actions
        .rename(progress.instance, label.trim(), {
          shortLabel: accountBadge(label, badge),
          badgeColor: color,
        })
        .catch(() =>
          toast.error({
            title: "Account added, but its badge could not be saved",
            description: "Change the badge from the account menu.",
          }),
        );
      void navigate({
        to: "/settings/providers/$provider",
        params: { provider: props.provider },
        hash: `account-${progress.instance}`,
      });
    },
  });
  const [error, setError] = useState<string>();
  const provider = props.provider;
  const support = useApiKeySupport(provider);
  const [method, setMethod] = useState<"login" | "api_key">("login");
  const [upstream, setUpstream] = useState<"openai" | "anthropic" | "openrouter" | "opencode">(
    "openai",
  );
  if (!canAddAccounts(provider)) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = label.trim();
    if (accountBadgeProblem(badge)) return setError(accountBadgeProblem(badge));
    if (!name) return setError("Give the account a name, like Work.");
    setError(undefined);
    try {
      keyLogin.start({
        provider,
        newAccount: name,
        shortLabel: accountBadge(label, badge),
        method,
        ...(method === "api_key" && provider === "opencode" ? { upstream } : {}),
      });
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
        <p className="text-sm text-muted-foreground">
          ace opens {props.name}'s own sign-in in your browser. Your password and tokens stay with{" "}
          {props.name}; ace never sees them.
        </p>
        <label htmlFor={nameId} className="text-sm">
          Name
        </label>
        <Input
          id={nameId}
          aria-label="Account name"
          autoFocus
          placeholder="Work"
          value={label}
          maxLength={128}
          aria-invalid={error !== undefined}
          onChange={(event) => setLabel(event.target.value)}
        />
        <AccountBadgeChooser
          provider={provider}
          value={badge}
          onChange={setBadge}
          name={label || "Work"}
          color={color}
          onColorChange={setColor}
        />
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
                options={apiServices.filter((option) =>
                  support.data?.upstreams?.includes(option.value),
                )}
                onValueChange={setUpstream}
              />
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={!!accountBadgeProblem(badge)}>
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
