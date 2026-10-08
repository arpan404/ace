import type { ProviderKind } from "@ace/protocol";
import { providerNames } from "@ace/ui-core";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { useProviderAccountModels } from "@/features/accounts/index.ts";
import { SignInButton } from "./sign-in-button.tsx";
import { useSignIn } from "./sign-in-host.tsx";

/**
 * Under a composer whose provider isn't signed in: says so, with Sign in right there. Nothing
 * while the provider is ready, or while its sign-in is merely unconfirmed (it may well work).
 */
export function SignInNotice(props: { provider: ProviderKind | undefined }) {
  const signIn = useSignIn();
  const { model } = useProviderAccountModels();
  const provider = props.provider;
  const view = provider && model(provider).view;
  if (!signIn || !provider || view?.primary !== "sign_in") return null;
  const name = providerNames[provider];
  return (
    <p role="status" className="mt-3 flex items-center gap-2 px-2 text-ui text-muted-foreground">
      <WarningCircleIcon aria-hidden size={16} className="shrink-0 text-status-failed" />
      <span className="min-w-0 flex-1">{`${name} isn't signed in. Sign in to start this thread.`}</span>
      <SignInButton variant="primary" target={{ provider }}>
        Sign in
      </SignInButton>
    </p>
  );
}
