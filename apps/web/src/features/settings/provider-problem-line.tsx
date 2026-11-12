import type { ProviderKind } from "@ace/protocol";
import { accountStatus, providerAccountViews, type ReadinessView } from "@ace/ui-core";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { useAccountViews } from "@/features/accounts/index.ts";
import { useSignIn } from "@/features/sign-in/index.ts";
import { useProviderConfiguration } from "@/lib/provider-configuration.ts";
import { useNow } from "@/lib/time.ts";
import { accountSignInTarget, providerProblem } from "./provider-problem.ts";

/**
 * The first thing on a provider's page when it, or its default account, needs the person: one
 * sentence on a faint needs-you surface and the one button that fixes it. Nothing when all is
 * well. `install` is the install control, used when the provider isn't on this computer.
 */
export function ProviderProblemLine(props: {
  provider: ProviderKind;
  acpAgentId?: string | undefined;
  instance?: string | undefined;
  name: string;
  missing: boolean;
  view: ReadinessView | undefined;
  install: ReactNode;
}) {
  const now = useNow();
  const accounts = useAccountViews({ enabled: !props.missing });
  const signIn = useSignIn();
  const preferences = useProviderConfiguration(props.provider);
  const own = providerAccountViews(accounts.data ?? [], props.provider, props.acpAgentId).find(
    (account) => account.isDefault,
  );
  const problem = providerProblem({
    provider: props.provider,
    name: props.name,
    missing: props.missing,
    view: props.view,
    accountsLoaded: accounts.data !== undefined,
    defaultAccount: own && { account: own, status: accountStatus(own, now) },
  });
  if (!problem) return null;
  const target = problem.account
    ? accountSignInTarget(problem.account, props.provider, props.name)
    : { provider: props.provider, instance: props.instance, name: props.name };
  const fix =
    problem.fix === "install" ? (
      props.install
    ) : problem.fix === "turn_on" ? (
      <Button
        size="sm"
        variant="secondary"
        aria-label={`Turn on ${props.name}`}
        disabled={preferences.disabled}
        onClick={() => void preferences.update((row) => ({ ...row, enabled: true }))}
      >
        Turn on
      </Button>
    ) : problem.fix && signIn ? (
      <Button
        size="sm"
        variant="secondary"
        aria-label={`${problem.fix === "sign_in" ? "Sign in to" : "Reconnect"} ${props.name}`}
        onClick={() => signIn(target)}
      >
        {problem.fix === "sign_in" ? "Sign in" : "Reconnect"}
      </Button>
    ) : null;
  return (
    <div
      role="status"
      className="mb-7 flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-[color-mix(in_oklab,var(--status-needs-you)_12%,var(--surface-1))] px-4 py-2 text-ui"
    >
      <p className="min-w-0 flex-1">{problem.text}</p>
      {fix && <div className="flex shrink-0 items-center gap-2">{fix}</div>}
    </div>
  );
}
