import { request } from "node:http";
import { ProviderSignInReturnUrl } from "@ace/protocol";

/*
 * An agent's Google sign-in returns the browser to a listener the agent runs on this computer
 * (`http://127.0.0.1:<port>/`). When the person signed in on another device, that page can't load
 * there, so they paste its address back and ace hands it to the listener here. The address holds a
 * one-time code: nothing here logs, keeps or repeats it, and errors carry fixed words only.
 */

/** Where the agent's sign-in returns to: its listener's port and path on this computer. */
export interface LoopbackReturn {
  port: number;
  path: string;
}

const loopbackHosts = new Set(["127.0.0.1", "localhost"]);
/** Long enough for the listener on this computer to answer, short enough to never hold a request. */
const forwardTimeoutMs = 5_000;
const maxResponseBytes = 64 * 1024;

function port(value: string): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number < 65536 ? number : undefined;
}

/** The loopback listener a sign-in page sends the browser back to, from its `redirect_uri`. */
export function loopbackReturn(page: string): LoopbackReturn | undefined {
  let redirect: URL;
  try {
    const url = new URL(page);
    if (url.protocol !== "https:") return undefined;
    redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
  } catch {
    return undefined;
  }
  const listening = port(redirect.port);
  if (redirect.protocol !== "http:" || !loopbackHosts.has(redirect.hostname) || !listening)
    return undefined;
  return { port: listening, path: redirect.pathname };
}

/**
 * The path and query to hand the listener, when a pasted address is this sign-in's own return:
 * a loopback host with the same port and path. Anything else is refused.
 */
export function returnPath(pasted: string, expected: LoopbackReturn): string | undefined {
  if (!ProviderSignInReturnUrl.safeParse(pasted).success) return undefined;
  let url: URL;
  try {
    url = new URL(pasted);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "http:" ||
    !loopbackHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.hash ||
    port(url.port) !== expected.port ||
    url.pathname !== expected.path ||
    url.search.length < 2
  )
    return undefined;
  return `${url.pathname}${url.search}`;
}

/** What the listener answered: its status, and whether it sent the browser on to another local page. */
export interface ReturnDelivered {
  status: number;
  /** The listener redirected to another page on this computer (Gemini Enterprise's license choice). */
  continuesLocally: boolean;
}

/**
 * Hand the return to the agent's listener on 127.0.0.1 only. Redirects are reported, never followed;
 * the reply's body is read and dropped. Answering is not proof of sign-in: the agent's own
 * `authenticate` still decides.
 */
export function deliverReturn(
  listener: LoopbackReturn,
  path: string,
  timeoutMs = forwardTimeoutMs,
): Promise<ReturnDelivered> {
  return new Promise((resolve, reject) => {
    const failed = () => reject(new Error("The sign-in return could not be delivered"));
    const outgoing = request(
      {
        host: "127.0.0.1",
        port: listener.port,
        path,
        method: "GET",
        agent: false,
        timeout: timeoutMs,
        headers: { connection: "close" },
      },
      (response) => {
        let received = 0;
        const location = response.headers.location;
        let continuesLocally = false;
        if (typeof location === "string") {
          try {
            const next = new URL(location, `http://127.0.0.1:${listener.port}`);
            continuesLocally = next.protocol === "http:" && loopbackHosts.has(next.hostname);
          } catch {
            continuesLocally = false;
          }
        }
        const status = response.statusCode ?? 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxResponseBytes) response.destroy();
        });
        response.on("error", () => resolve({ status, continuesLocally }));
        response.on("close", () => resolve({ status, continuesLocally }));
        response.resume();
      },
    );
    outgoing.on("timeout", () => outgoing.destroy());
    outgoing.on("error", failed);
    outgoing.end();
  });
}
