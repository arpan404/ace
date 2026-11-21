import { machineCodeAdmin, type ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { openExternalWhenReady } from "@/boot/open-external.ts";
import { proveAgain } from "@/boot/window-prover.ts";
import { useAceAccountStore } from "./account-context.tsx";
import type { AceAccountStore } from "./session-store.ts";

type Confirmation = {
  client?: ClientApi;
  onConfirmed(): void;
  beforeProof?(origin: string, token: string): Promise<void>;
  freshSignIn?: boolean;
  freshSignInSentence?: string;
  className?: string;
};

export function ConfirmPerson(props: Confirmation) {
  const current = useClient();
  const store = useAceAccountStore();
  return <PersonConfirmation {...props} client={props.client ?? current} store={store} />;
}

export function PersonConfirmation(
  props: Confirmation & { client: ClientApi; store: AceAccountStore | undefined },
) {
  const { client, store } = props;
  const [signing, setSigning] = useState(false);
  const [problem, setProblem] = useState<string>();
  const attempt = useRef<AbortController | undefined>(undefined);
  const [ownerStatus, setOwnerStatus] = useState<{ client: ClientApi; unowned: boolean }>();
  useEffect(() => {
    const controller = new AbortController();
    if (!props.freshSignIn) {
      const report = (unowned: boolean) => {
        if (!controller.signal.aborted) setOwnerStatus({ client, unowned });
      };
      void machineCodeAdmin(client)
        .status({ signal: controller.signal, timeoutMs: 5_000 })
        .then((reply) => report(reply.ok && reply.status.owner === null))
        .catch(() => report(false));
    }
    return () => {
      controller.abort();
      attempt.current?.abort();
    };
  }, [client, props.freshSignIn]);
  const reading = !props.freshSignIn && ownerStatus?.client !== client;
  const confirm = async () => {
    if (!store || attempt.current) return;
    const active = new AbortController();
    attempt.current = active;
    setSigning(true);
    setProblem(undefined);
    try {
      const signed = await store.signInAgain(openExternalWhenReady);
      const session = store.get().session;
      if (!signed || !session) {
        setProblem(store.get().error || "Sign-in didn't finish. Try again.");
        return;
      }
      if (active.signal.aborted) return;
      await props.beforeProof?.(store.origin, session.token);
      const proved = await proveAgain(client);
      if (active.signal.aborted) return;
      if (!props.freshSignIn && !proved) {
        setProblem("ace couldn't confirm it's you on this machine.");
        return;
      }
      props.onConfirmed();
    } catch {
      setProblem("ace couldn't finish confirming it's you. Try again.");
    } finally {
      attempt.current = undefined;
      setSigning(false);
    }
  };
  return (
    <span role="status" className={props.className}>
      {signing
        ? "Finishing sign-in in your browser."
        : reading
          ? "Checking who owns this machine."
          : (problem ??
            (props.freshSignIn
              ? (props.freshSignInSentence ?? "Sign in again to do this.")
              : ownerStatus?.unowned
                ? "This Mac will be yours: confirm it's you."
                : "Confirm it's you to continue."))}{" "}
      {!signing &&
        !reading &&
        (store ? (
          <button
            type="button"
            className="text-[var(--ring-text)] underline underline-offset-2"
            onClick={() => void confirm()}
          >
            {props.freshSignIn ? "Sign in again" : "Confirm it's you"}
          </button>
        ) : props.freshSignIn ? (
          <Link
            className="text-[var(--ring-text)] underline underline-offset-2"
            to="/settings/profile"
          >
            Sign in
          </Link>
        ) : null)}
    </span>
  );
}
