import { useClient } from "@ace/client-react";
import { ClientError, type ClientApi } from "@ace/client";
import type { ForgeMediaRole, ForgeMediaUnavailable } from "@ace/protocol";
import { useContext, useLayoutEffect, useState } from "react";
import { permanentFailure } from "@/components/byte-loads.ts";
import { forgeMediaLoads, type ReadyMedia } from "./media-loads.ts";
import { ForgeContentScope } from "./scope.ts";

export type MediaView =
  /** Not known yet whether there is media; `media` once it is but bytes are on their way. */
  | { phase: "loading"; media?: ReadyMedia | undefined }
  | { phase: "ready"; media: ReadyMedia; url: string }
  /** A link the forge shows as a link. */
  | { phase: "none" }
  | { phase: "unavailable"; reason: ForgeMediaUnavailable };

/** A download the daemon answered with "not here": the hash isn't (or no longer) served. */
const missingBytes = (error: unknown) =>
  error instanceof ClientError && error.code === "daemon" && error.message === "NOT_FOUND";

const passing = new Set<ForgeMediaUnavailable>(["failed", "offline", "rate_limited"]);
/** A failure that may pass is asked about again this much later, or when the connection is back. */
const recheckMs = 15_000;

/**
 * The media `url` names in forge text, while mounted: resolved through the daemon, then its bytes
 * as an object URL this component holds and revokes. Outside a forge page (no scope) it is
 * unavailable, so the fallback offers GitHub.
 */
export function useForgeMedia(url: string | undefined, role: ForgeMediaRole): MediaView {
  const client = useClient();
  const scope = useContext(ForgeContentScope);
  const loads = forgeMediaLoads(client);
  const item = url ? { url, role } : undefined;
  const key = scope && item ? `${scope.workspaceId}\u0000${role}\u0000${url}` : "";
  const known = scope && item ? loads.known(scope, item) : undefined;
  const [view, setView] = useState<{ client: ClientApi; key: string; view: MediaView }>();
  const [round, setRound] = useState(0);
  // Bytes the daemon no longer holds are resolved again, once per item.
  const [renewed, setRenewed] = useState<string>();
  // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `key` names scope and item.
  useLayoutEffect(() => {
    if (!scope || !item) return;
    let live = true;
    let objectUrl: string | undefined;
    let release: (() => void) | undefined;
    let stopRecheck: (() => void) | undefined;
    const show = (next: MediaView) => {
      if (live) setView({ client, key, view: next });
    };
    const recheck = () => {
      const timer = setTimeout(() => live && setRound((count) => count + 1), recheckMs);
      let wasReady = client.state === "ready";
      const stop = client.connectionState().subscribe(() => {
        const ready = client.state === "ready";
        if (ready && !wasReady && live) setRound((count) => count + 1);
        wasReady = ready;
      });
      return () => {
        clearTimeout(timer);
        stop();
      };
    };
    const bytes = (media: ReadyMedia) => {
      const shown = (blob: Blob) => {
        objectUrl = URL.createObjectURL(blob);
        show({ phase: "ready", media, url: objectUrl });
      };
      const hit = loads.cachedBytes(scope, media);
      if (hit) return shown(hit);
      show({ phase: "loading", media });
      const lease = loads.acquireBytes(scope, media);
      release = lease.release;
      lease.promise.then(
        (blob) => live && shown(blob),
        (error: unknown) => {
          if (!live) return;
          if (missingBytes(error) && renewed !== key) {
            // Evicted from the daemon's cache, or not granted since it restarted: a fresh
            // resolve fetches it again (or grants it), rather than "couldn't load" for half an hour.
            loads.forget(scope, item);
            setRenewed(key);
            setRound((count) => count + 1);
            return;
          }
          show({ phase: "unavailable", reason: "failed" });
          if (!permanentFailure(error)) stopRecheck = recheck();
        },
      );
    };
    void loads.resolve(scope, item).then((result) => {
      if (!live) return;
      if (result.state === "ready") bytes(result);
      else if (result.state === "none") show({ phase: "none" });
      else {
        show({ phase: "unavailable", reason: result.reason });
        if (passing.has(result.reason)) stopRecheck = recheck();
      }
    });
    return () => {
      live = false;
      stopRecheck?.();
      release?.();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // `key` names the scope and item; `round` asks again.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, round]);
  if (!scope || !item) return { phase: "unavailable", reason: "forbidden" };
  if (view?.client === client && view.key === key) return view.view;
  if (known?.state === "none") return { phase: "none" };
  return { phase: "loading", media: known?.state === "ready" ? known : undefined };
}
