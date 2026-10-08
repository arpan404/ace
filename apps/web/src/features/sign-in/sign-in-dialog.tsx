import { useToast } from "@/components/ui/toast.tsx";
import { providerNames } from "@ace/ui-core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import { ProviderTile } from "@/components/provider-tile.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { refreshProviders, useProviderReadiness } from "@/lib/provider-readiness.ts";
import { isFinished, type LoginController, type LoginView } from "./login-controller.ts";
import { LoginBody } from "./login-steps.tsx";

/** Waiting on the CLI or on the person elsewhere: the mark breathes meanwhile. */
function waiting(view: LoginView): boolean {
  if (view.kind === "requesting") return true;
  if (view.kind !== "progress") return false;
  const state = view.progress.state;
  return (
    state === "starting" ||
    state === "verifying" ||
    state === "awaiting_browser" ||
    state === "awaiting_code_entry"
  );
}

/**
 * Signing in to (or out of) a provider with its own CLI, as the daemon runs it: one calm column
 * under the provider's mark, with a code to copy and a page to open, the CLI's own choices, a
 * terminal for what only the CLI should read, and what went wrong with one way to try again.
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
  const toast = useToast();
  const queryClient = useQueryClient();
  const { provider, action, service, choice } = login.target;
  const name = login.target.name ?? providerNames[provider];
  const row = readiness.data?.find((entry) => entry.provider === provider);
  const succeeded = view.kind === "progress" && view.progress.state === "succeeded";
  const finish = useEffectEvent(() => {
    toast.add({
      title:
        action === "logout"
          ? `Signed out of ${name}`
          : `Signed in to ${name}${login.target.newAccount ? ` · ${login.target.newAccount}` : ""}`,
    });
    props.onClose();
  });
  useEffect(() => {
    if (!succeeded) return;
    // The daemon pushed the new readiness already; read it again in case that push was missed.
    refreshProviders(queryClient);
    void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    finish();
  }, [succeeded, queryClient]);
  const running = view.kind === "progress" && !isFinished(view.progress);
  const logout = action === "logout";
  const title = service
    ? `${logout ? "Disconnect" : "Connect"} ${service}`
    : logout
      ? `Sign out of ${name}`
      : `Sign in to ${name}`;
  const description = logout
    ? service
      ? `${name} stops using ${service} on the computer running ace.`
      : `Signs ${name} out on the computer running ace.`
    : provider === "cursor"
      ? "Signs in through the Cursor SDK in your browser. ace never sees your password."
      : `Uses ${name}'s own sign-in. Your credentials stay with ${name}.`;
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        size="md"
        className="gap-5 px-6 pt-7 pb-5"
        aria-busy={running || view.kind === "requesting" || undefined}
      >
        <DialogHeader className="items-center gap-1.5 px-6 text-center">
          <span className="relative mb-2">
            {waiting(view) && (
              <span
                aria-hidden
                className="fx-ring absolute inset-0 rounded-card bg-status-working/40"
              />
            )}
            <ProviderTile
              provider={provider}
              service={service && choice ? { id: choice, label: service } : undefined}
              size="lg"
              className="relative"
            />
          </span>
          <DialogTitle className="text-lg font-semibold tracking-title">{title}</DialogTitle>
          <DialogDescription className="max-w-[44ch] text-balance">{description}</DialogDescription>
        </DialogHeader>
        {/* Each step is read out as it appears: the code, the choices, the outcome. */}
        <DialogBody aria-live="polite">
          <LoginBody
            login={login}
            view={view}
            name={name}
            row={login.target.instance || login.target.newAccount ? undefined : row}
            onClose={props.onClose}
            onRetry={props.onRetry}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
