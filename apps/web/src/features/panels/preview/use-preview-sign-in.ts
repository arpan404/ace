import type { BrowserFailure } from "@ace/ui-core";
import { useEffect, useRef, useState } from "react";
import { schedule as defaultSchedule, type Schedule } from "../schedule.ts";
import type { PreviewServer, PreviewSource } from "../sources.ts";
import { signInFailure } from "./preview-errors.ts";

/** Renew this long before the session would end. */
const renewAheadMs = 5 * 60_000;
/** A renewal that failed tries again after this long. */
const renewRetryMs = 60_000;

/**
 * Redeem a sign-in link without loading the page: the gateway answers a fetch (not a
 * navigation) with only its cookies, which land in the same cookie partition as the framed
 * preview's, so the page in the frame keeps its state.
 */
export async function renewInBackground(url: string): Promise<void> {
  await fetch(url, {
    mode: "no-cors",
    credentials: "include",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
}

export type PreviewSignIn =
  | { phase: "signing-in" }
  /** `renewals`: sessions renewed in the background since this load signed in. */
  | { phase: "ready"; src: string; renewals: number }
  | { phase: "failed"; failure: BrowserFailure };

/**
 * What a dev server's frame loads. A server behind the daemon's preview gateway needs a session,
 * so each load (each `load` value) asks the daemon for a fresh single-use sign-in link and loads
 * that; then, while the frame stays, the session is renewed in the background before it ends.
 * A server without a gateway origin loads its own address.
 */
export function usePreviewSignIn(
  source: PreviewSource,
  threadId: string,
  server: Pick<PreviewServer, "port" | "origin">,
  load: string,
  options: { schedule?: Schedule; renew?: (url: string) => Promise<void> } = {},
): PreviewSignIn {
  const { port, origin } = server;
  // Timers and the renewal are read when used, so passing new functions doesn't sign in again.
  const io = useRef({ later: defaultSchedule, renew: renewInBackground });
  useEffect(() => {
    io.current = {
      later: options.schedule ?? defaultSchedule,
      renew: options.renew ?? renewInBackground,
    };
  });
  const key = `${threadId}\u0000${port}\u0000${origin ?? ""}\u0000${load}`;
  const [state, setState] = useState<{ key: string; signIn: PreviewSignIn }>({
    key: "",
    signIn: { phase: "signing-in" },
  });
  useEffect(() => {
    if (!origin) return;
    let stopped = false;
    let cancel: (() => void) | undefined;
    const plan = (ms: number) => {
      cancel = io.current.later(
        () => {
          source
            .link(threadId, port)
            .then(async (next) => {
              await io.current.renew(next.url);
              if (stopped) return;
              setState((current) =>
                current.key === key && current.signIn.phase === "ready"
                  ? { key, signIn: { ...current.signIn, renewals: current.signIn.renewals + 1 } }
                  : current,
              );
              plan(next.sessionMs - renewAheadMs);
            })
            .catch(() => {
              // The session still has time left; a frame that outlives it is told to sign in
              // again by the gateway's refusal page.
              if (!stopped) plan(renewRetryMs);
            });
        },
        Math.max(renewRetryMs, ms),
      );
    };
    source.link(threadId, port).then(
      (link) => {
        if (stopped) return;
        setState({ key, signIn: { phase: "ready", src: link.url, renewals: 0 } });
        plan(link.sessionMs - renewAheadMs);
      },
      (error: unknown) => {
        if (!stopped)
          setState({ key, signIn: { phase: "failed", failure: signInFailure(error, port) } });
      },
    );
    return () => {
      stopped = true;
      cancel?.();
    };
  }, [key, source, threadId, port, origin]);
  if (!origin) return { phase: "ready", src: `http://localhost:${port}`, renewals: 0 };
  return state.key === key ? state.signIn : { phase: "signing-in" };
}
