import { localDaemonAt, readHomeCredentials, readLocalDaemon, type LocalDaemon } from "./probe.ts";

/** What answers at the address the home names: this home's daemon, nothing yet, or another. */
export type EndpointAnswer = "ours" | "nothing" | "other";

/**
 * Asks the endpoint's authenticated status once, briefly. Accepted: this home's daemon. Refused
 * at the socket: nothing listens yet (the daemon is still starting). Anything else (a refused
 * token, a timeout, another server) may be some other daemon on that port.
 */
export async function endpointAnswer(
  daemon: LocalDaemon,
  timeoutMs = 300,
): Promise<EndpointAnswer> {
  try {
    const response = await fetch(new URL("/v1/status", daemon.origin), {
      headers: { authorization: `Bearer ${daemon.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return response.ok ? "ours" : "other";
  } catch (error) {
    return connectionRefused(error) ? "nothing" : "other";
  }
}

function connectionRefused(error: unknown): boolean {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause)
    if ("code" in cause && cause.code === "ECONNREFUSED") return true;
  return false;
}

/**
 * The daemon this home will most likely be served by, before it answers. Its token and identity
 * never change for a home; its address is the endpoint file of a daemon running now, else the
 * address the window was last handed (`remembered`, a loopback `ws:` URL; a daemon that stops
 * removes its endpoint file, and starts again on the same port). The window can open on what it
 * kept for that daemon while it starts, instead of waiting for it. Undefined when there's no
 * telling, or when something other than this home's daemon answers there, so the window never
 * meets another daemon's refusal.
 */
export async function expectedLocalDaemon(
  home: string,
  remembered: string | undefined,
  answer: (daemon: LocalDaemon) => Promise<EndpointAnswer> = endpointAnswer,
): Promise<LocalDaemon | undefined> {
  const running = await readLocalDaemon(home);
  const daemon = running ?? (await rememberedDaemon(home, remembered));
  if (!daemon) return undefined;
  return (await answer(daemon)) === "other" ? undefined : daemon;
}

async function rememberedDaemon(
  home: string,
  remembered: string | undefined,
): Promise<LocalDaemon | undefined> {
  if (!remembered) return undefined;
  let origin: string;
  try {
    const url = new URL(remembered);
    if (url.protocol !== "ws:" || url.pathname !== "/" || url.search || url.hash) return undefined;
    origin = `http://${url.host}/`;
  } catch {
    return undefined;
  }
  const credentials = await readHomeCredentials(home);
  return credentials && localDaemonAt(origin, credentials);
}
