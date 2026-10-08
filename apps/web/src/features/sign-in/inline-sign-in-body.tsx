import { useToast } from "@/components/ui/toast.tsx";
import { apiKeyServiceLabel } from "@ace/ui-core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import { refreshProviders } from "@/lib/provider-readiness.ts";
import type { LoginController } from "./login-controller.ts";
import { LoginBody } from "./login-steps.tsx";

export function InlineSignIn(props: { login: LoginController; onClose(): void; onRetry(): void }) {
  const view = useSyncExternalStore(props.login.subscribe, props.login.getView);
  const queries = useQueryClient();
  const toast = useToast();
  const close = useEffectEvent(() => {
    toast.add({
      title: `Signed in${props.login.target.newAccount ? ` · ${props.login.target.newAccount}` : ""}`,
    });
    props.onClose();
  });
  const succeeded = view.kind === "progress" && view.progress.state === "succeeded";
  useEffect(() => {
    if (succeeded) {
      refreshProviders(queries);
      void queries.invalidateQueries({ queryKey: ["accounts"] });
      close();
    }
  }, [succeeded, queries]);
  const target = props.login.target;
  const name = apiKeyServiceLabel(target.provider, target.upstream);
  return (
    <div className="py-3" aria-live="polite">
      <LoginBody
        login={props.login}
        view={view}
        name={name}
        row={undefined}
        onClose={props.onClose}
        onRetry={props.onRetry}
      />
    </div>
  );
}
