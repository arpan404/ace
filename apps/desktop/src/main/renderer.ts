import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { protocol, session } from "electron";
import { appOrigin, appScheme, contentSecurityPolicy, packagedPolicy } from "./csp.ts";
import type { DaemonNetwork } from "./daemon-network.ts";

/** Covers fetches and worker sockets as well as the page. Browser views use other sessions. */
export function installDaemonNetwork(network: DaemonNetwork): void {
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (details, callback) => callback({ cancel: !network.allows(details.url, details.resourceType) }),
  );
}

/** Must run before `app.ready`: `app://` behaves like https for storage, fetch and CSP. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: appScheme,
      privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
    },
  ]);
}

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

/**
 * Serves the built web app from disk at `app://ace/`. Unknown paths fall back to index.html
 * so client-side routes survive a reload. Every response carries the CSP.
 */
export async function serveRenderer(
  directory: string,
  daemonOrigins: readonly string[],
  network?: DaemonNetwork,
) {
  const index = await readFile(join(directory, "index.html"), "utf8");
  const policy = packagedPolicy({ index, daemonOrigins, dynamicDaemons: network !== undefined });
  const root = normalize(directory + sep);
  protocol.handle(appScheme, async (request) => {
    const url = new URL(request.url);
    if (url.host !== "ace") return new Response("Not found", { status: 404 });
    const path = normalize(join(directory, decodeURIComponent(url.pathname)));
    const headers = { "content-security-policy": policy, "x-content-type-options": "nosniff" };
    if (path.startsWith(root) && extname(path)) {
      try {
        const body = await readFile(path);
        return new Response(body, {
          headers: {
            ...headers,
            "content-type": types[extname(path)] ?? "application/octet-stream",
          },
        });
      } catch {
        return new Response("Not found", { status: 404, headers });
      }
    }
    return new Response(index, { headers: { ...headers, "content-type": types[".html"] ?? "" } });
  });
  return `${appOrigin}/`;
}

/** In development the Vite server serves the page; the CSP is added to its responses. */
export function applyDevCsp(
  devUrl: string,
  daemonOrigins: readonly string[],
  network?: DaemonNetwork,
): void {
  const origin = new URL(devUrl).origin;
  const policy = contentSecurityPolicy({
    dev: { origin },
    daemonOrigins,
    dynamicDaemons: network !== undefined,
  });
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: [`${origin}/*`] },
    (details, callback) =>
      callback({
        responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [policy] },
      }),
  );
}
