import { afterEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { BrowserServerMessage, BrowserTab } from "@ace/protocol";
import { BrowserService, connectBrowser, detectChromium } from "./index.ts";
import type { BrowserServiceOptions } from "./service-options.ts";

export const executablePath = await detectChromium();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
}, 60_000);

export const siteUser = { username: "ada", password: "lovelace" };
const authorization = `Basic ${Buffer.from(`${siteUser.username}:${siteUser.password}`).toString("base64")}`;
const html = (response: ServerResponse, body: string) => {
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><meta charset="utf-8">${body}`);
};
/** Pages for the edge cases: a sign-in, an OAuth-style popup and the window it opens. */
function route(request: IncomingMessage, response: ServerResponse): void {
  const path = request.url ?? "/";
  if (path.startsWith("/private")) {
    if (request.headers.authorization === authorization) {
      html(response, "<title>Members</title><p>Signed in as ada</p>");
      return;
    }
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Fixture members"' });
    response.end("Sign-in required");
    return;
  }
  if (path === "/oauth")
    return html(
      response,
      `<title>App</title><button onclick="window.open('/consent','provider','width=480,height=640')">Sign in with Provider</button>
<p id="status">signed out</p>
<script>addEventListener('message',(event)=>{document.getElementById('status').textContent='token '+event.data})</script>`,
    );
  if (path === "/consent")
    return html(
      response,
      `<title>Provider</title><button onclick="window.opener.postMessage('abc123','*');window.close()">Allow</button>`,
    );
  if (path === "/upload")
    return html(
      response,
      `<title>Upload</title><label>Avatar <input type="file" aria-label="Avatar"></label><p id="out">none</p>
<script>document.querySelector('input').addEventListener('change',async(event)=>{const file=event.target.files[0];document.getElementById('out').textContent='picked '+file.name+': '+(await file.text())})</script>`,
    );
  if (path === "/new-tab")
    return html(response, `<title>Links</title><a href="/consent" target="_blank">Docs</a>`);
  html(response, "<title>Home</title><p>Home page</p>");
}

/** ace's Chrome with local fixture sites, driven as an agent and as the person's client. */
export async function pageEdges(options: Partial<BrowserServiceOptions> = {}) {
  const home = await mkdtemp(join(tmpdir(), "ace-page-edges-"));
  const server = createServer(route);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const secure = createHttpsServer(
    {
      key: await readFile(new URL("./testing/localhost-key.pem", import.meta.url)),
      cert: await readFile(new URL("./testing/localhost-cert.pem", import.meta.url)),
    },
    (request, response) => html(response, `<title>Dev server</title><p>Secure ${request.url}</p>`),
  );
  await new Promise<void>((resolve) => secure.listen(0, "127.0.0.1", resolve));
  const port = (target: typeof server | typeof secure) => {
    const address = target.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    return address.port;
  };
  const service = new BrowserService({
    dataDir: home,
    ...(executablePath ? { executablePath } : {}),
    ...options,
  });
  const messages: BrowserServerMessage[] = [];
  /** Files the person's device uploaded as thread attachments, by sha256. */
  const attachments = new Map<string, Buffer>();
  const bridge = connectBrowser(service, {
    connectionId: "person",
    authorize: () => true,
    attachment: async (_threadId, sha256) => {
      const bytes = attachments.get(sha256);
      if (!bytes) throw new Error("Thread attachment unavailable");
      return {
        chunks: (async function* () {
          yield bytes;
        })(),
        close: async () => {},
      };
    },
    send: (message) => {
      messages.push(message);
      return true;
    },
  });
  cleanups.push(async () => {
    bridge.close();
    try {
      await service.close();
    } finally {
      for (const target of [server, secure]) {
        target.closeAllConnections();
        await new Promise<void>((resolve) => target.close(() => resolve()));
      }
      await rm(home, { recursive: true, force: true });
    }
  });
  await service.open({ threadId: "thread", workspaceId: "workspace" });
  let request = 0;
  const agent = { kind: "agent" as const, agentId: "agent-1" };
  return {
    service,
    home,
    attachments,
    url: `http://127.0.0.1:${port(server)}`,
    secureUrl: `https://localhost:${port(secure)}`,
    agent: (command: Record<string, unknown>) => service.execute("thread", command, agent),
    /** A request from the person's client, through the same bridge a socket uses. */
    async person(message: Record<string, unknown>): Promise<unknown> {
      const requestId = `r${++request}`;
      await bridge.handle({ requestId, threadId: "thread", ...message });
      const result = messages.find(
        (candidate) => candidate.type === "browser.result" && candidate.requestId === requestId,
      );
      if (result?.type !== "browser.result") throw new Error("No browser result");
      if (!result.ok) throw new Error(result.error);
      return result.result;
    },
    tabs: (): BrowserTab[] => service.state("thread").tabs ?? [],
    text: async (tabId?: string) =>
      z.string().parse(
        await service.execute(
          "thread",
          {
            action: "evaluate",
            expression: "document.body.innerText",
            ...(tabId ? { tabId } : {}),
          },
          agent,
        ),
      ),
  };
}
