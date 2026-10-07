import { providerNames } from "@ace/ui-core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { refreshProviders, useProviderReadiness } from "@/lib/provider-readiness.ts";
import { isFinished, type LoginController } from "./login-controller.ts";
import { LoginBody } from "./login-steps.tsx";

/** How long "Signed in" stays before the dialog closes by itself. */
const doneMs = 1_600;

/**
 * Signing in to (or out of) a provider with its own CLI, as the daemon runs it: a link to open
 * and a code to enter on this device, the CLI's own choices as buttons, a terminal for flows
 * that need typing a secret, and what went wrong with a way to try again.
 */
export function SignInDialog(props: {
  login: LoginController;
  open: boolean;
  onClose(): void;
  onRetry(): void;
}) {
  const { login } = props;
  const view = useSyncExternalStore(login.subscribe, login.getView);
  const readiness = useProviderReadiness();
  const queryClient = useQueryClient();
  const { provider, action } = login.target;
  const name = providerNames[provider];
  const row = readiness.data?.find((entry) => entry.provider === provider);
  const succeeded = view.kind === "progress" && view.progress.state === "succeeded";
  const finish = useEffectEvent(() => props.onClose());
  useEffect(() => {
    if (!succeeded) return;
    // The daemon pushed the new readiness already; read it again in case that push was missed.
    refreshProviders(queryClient);
    const timer = setTimeout(() => finish(), doneMs);
    return () => clearTimeout(timer);
  }, [succeeded, queryClient]);
  const running = view.kind === "progress" && !isFinished(view.progress);
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent size="md" aria-busy={running || view.kind === "requesting" || undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ProviderIcon provider={provider} size={16} decorative />
            {action === "logout" ? `Sign out of ${name}` : `Sign in to ${name}`}
          </DialogTitle>
          <DialogDescription>
            {provider === "cursor"
              ? "Signs in to Cursor in your browser, through the Cursor SDK ace runs. It's separate from the Cursor editor's sign-in; ace never sees your credentials."
              : `ace runs ${name}'s own sign-in. Your credentials stay with the CLI; ace never sees them.`}
          </DialogDescription>
        </DialogHeader>
        {/* Each step is read out as it appears: the code, the choices, the outcome. */}
        <DialogBody aria-live="polite">
          <LoginBody
            login={login}
            view={view}
            name={name}
            row={row}
            onClose={props.onClose}
            onRetry={props.onRetry}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
