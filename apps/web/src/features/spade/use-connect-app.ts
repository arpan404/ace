import {
  spadeDeviceLine,
  spadeSignInFailureWords,
  type SpadeConnectStart,
  type SpadeConnector,
} from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useState } from "react";
import { beginConnect } from "./spade-connect-flow.ts";
import { connect, connectorsKey, readConnector, reconnect } from "./spade-connector-api.ts";
import { useSpadeClient } from "./spade-machine.tsx";

/**
 * Connecting one app from wherever it's asked for (a bot's connect card, suggested apps): one
 * click opens the sign-in in the person's browser, then the app follows it in one line until it
 * comes back connected, fails with what fixes it, or the person cancels. A key is sent once and
 * never kept here. Nothing connects unless the person started it.
 */
export type ConnectPhase =
  | { kind: "idle" }
  | { kind: "starting" }
  /**
   * Signing in in the browser; Spade waits for it to come back. `blocked`: the browser blocked
   * the tab, so the sign-in at `url` is offered as a link to open.
   */
  | { kind: "waiting"; id: string; url: string; blocked: boolean }
  /** A device sign-in: the code to enter on the app's page. */
  | { kind: "device"; id: string; code: string; url: string }
  | { kind: "connected"; connector: SpadeConnector }
  | { kind: "failed"; message: string };

/** What starts a connection: a catalogue app (maybe with a key), or one to sign in to again. */
export type ConnectTarget =
  | { catalogue: string; token?: string }
  | { reconnect: string; token?: string };

/** How often a sign-in in progress is read. */
const followMs = 1_500;
/** A sign-in Spade no longer knows of after this has ended without connecting. */
const giveUpMs = 10 * 60_000;

export function useConnectApp(props: {
  /** The app's name, for the words. */
  name: string;
  onConnected(connector: SpadeConnector): void;
}) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const [phase, setPhase] = useState<ConnectPhase>({ kind: "idle" });
  const done = (connector: SpadeConnector) => {
    setPhase({ kind: "connected", connector });
    void cache.invalidateQueries({ queryKey: connectorsKey });
    props.onConnected(connector);
  };
  // What a read of the sign-in says, with the latest props: connected, failed, or still going.
  const followed = useEffectEvent((connector: SpadeConnector): boolean => {
    if (connector.state === "connected") {
      done(connector);
      return true;
    }
    if (connector.failed) {
      setPhase({ kind: "failed", message: spadeSignInFailureWords(props.name, connector.failed) });
      return true;
    }
    if (connector.device && connector.device.state !== "waiting") {
      setPhase({ kind: "failed", message: spadeDeviceLine(props.name, connector.device) });
      return true;
    }
    return false;
  });
  const started = (start: SpadeConnectStart, blocked: boolean) => {
    switch (start.kind) {
      case "connected":
        return done(start.connector);
      case "sign_in":
        return setPhase({ kind: "waiting", id: start.id, url: start.url, blocked });
      case "device":
        return setPhase({ kind: "device", id: start.id, code: start.code, url: start.url });
    }
  };
  const start = async (target: ConnectTarget) => {
    setPhase({ kind: "starting" });
    const token = target.token?.trim() || undefined;
    const request = () =>
      "catalogue" in target
        ? connect(client, { catalogue: target.catalogue, ...(token ? { token } : {}) })
        : reconnect(client, target.reconnect, token ? { token } : {});
    const begun = await beginConnect(request, !token);
    if (begun.kind === "started") return started(begun.started, begun.blocked);
    setPhase({
      kind: "failed",
      message:
        begun.kind === "needs_ace_account"
          ? `${props.name} signs in through Spade Cloud: sign in to ace first, in Settings › Profile.`
          : begun.message,
    });
  };
  // Follows a sign-in until it ends, read again every `followMs`.
  const following = phase.kind === "waiting" || phase.kind === "device" ? phase.id : undefined;
  useEffect(() => {
    if (!following) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const since = Date.now();
    const read = async () => {
      try {
        const connector = await readConnector(client, following);
        if (stopped || followed(connector)) return;
      } catch {
        // Not there yet (a first sign-in has no row until it comes back), or a blip: read again.
        if (stopped) return;
      }
      if (Date.now() - since > giveUpMs)
        return setPhase({ kind: "failed", message: "The sign-in took too long. Connect again." });
      timer = setTimeout(() => void read(), followMs);
    };
    timer = setTimeout(() => void read(), followMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [following, client]);
  return {
    phase,
    start,
    /** Stops following the sign-in; one already open in the browser just goes unused. */
    cancel: () => setPhase({ kind: "idle" }),
  };
}

/** The sign-in to open by hand, when the browser blocked its tab. */
export function blockedSignIn(phase: ConnectPhase): string | undefined {
  return phase.kind === "waiting" && phase.blocked ? phase.url : undefined;
}

/** The one line a connection in progress shows, or undefined when nothing is under way. */
export function connectProgress(phase: ConnectPhase, name: string): string | undefined {
  switch (phase.kind) {
    case "starting":
      return `Opening ${name}…`;
    case "waiting":
      return phase.blocked
        ? `Your browser didn't open ${name}'s sign-in. Open it, and this updates by itself.`
        : `Finish signing in to ${name} in your browser. This updates by itself.`;
    case "device":
      return `Enter ${phase.code} on ${name}'s page to finish signing in.`;
    default:
      return undefined;
  }
}
