import { useClient } from "@ace/client-react";
import { Suspense, useEffect, useState } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { LoginController, type SignInTarget } from "./login-controller.ts";
const InlineSignIn = deferredComponent(() =>
  import("./inline-sign-in-body.tsx").then((module) => module.InlineSignIn),
);

/** Own an ephemeral key hand-off beside the account that requested it. */
export function useInlineSignIn(options: { onClose?(): void } = {}) {
  const client = useClient();
  const [login, setLogin] = useState<LoginController>();
  useEffect(() => () => login?.dispose(), [login]);
  const close = () => {
    setLogin(undefined);
    options.onClose?.();
  };
  const start = (target: SignInTarget) => {
    login?.dispose();
    setLogin(new LoginController(client, target));
  };
  return {
    start,
    active: !!login,
    content: login && (
      <Suspense fallback={null}>
        <InlineSignIn.Component login={login} onClose={close} onRetry={() => start(login.target)} />
      </Suspense>
    ),
  };
}
