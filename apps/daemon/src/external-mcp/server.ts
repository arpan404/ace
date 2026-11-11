import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TLSSocket } from "node:tls";
import {
  aceToolDispatch,
  aceToolSearch,
  nodeListener,
  nodeScheduler,
  startMcpServer,
  type ResourceFetch,
} from "@ace/mcp-server";
import { computerToolNames } from "@ace/screen";
import {
  WorkspaceId,
  type AgentControlResult,
  type CliOperation,
  type OutsideEndpoint,
  type OutsideScope,
} from "@ace/protocol";
import type { ServiceContext } from "../services/types.ts";
import { daemonComputerToolkit } from "../computer-tools.ts";
import { computerName } from "../computer-name.ts";
import type { RelayHttpHandler } from "../relay-http.ts";
import { baseOfResource, resourceMetadataUrl, type OutsideBase } from "./oauth/base.ts";
import { publicMetadataFetch } from "./oauth/cimd-fetch.ts";
import { outsideOAuth } from "./oauth/service.ts";
import {
  loopbackBase,
  outsidePath,
  reachEndpoints,
  relayBase,
  tailscaleBase,
  unreachable,
  type ReachFacts,
  type ReachSettings,
} from "./reach.ts";
import { outsideBrowserToolkit } from "./browser.ts";
import { endpointPort } from "./endpoint-port.ts";
import { OutsideAccess } from "./outside.ts";
import { grantOfCaller } from "./principals.ts";
import { missingScope, shorthandScopes, withheldTools } from "./scopes.ts";
import { tokenFiles } from "./token-files.ts";
import { externalTools } from "./tools.ts";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export type ExternalMcp = Awaited<ReturnType<typeof externalMcp>>;

/**
 * The endpoint for MCP clients outside ace (ADR 0117): a loopback listener with its own tool
 * registry, whose callers are outside grants. Grants and their tokens live in SQLite, so they
 * survive a restart; every request reads its grant again.
 */
export async function externalMcp(context: ServiceContext) {
  const files = tokenFiles(context.config.dataDir);
  let toolsChanged: (() => void) | undefined;
  const testing = context.options.outsideClients;
  const sql = {
    statement: (text: string) => context.store.statement(text),
    atomic: <T>(run: () => T) => context.store.atomic(() => run()),
  };
  const outside = new OutsideAccess({
    sql,
    now: context.now,
    id: context.id,
    ...(testing?.requestTtlMs === undefined ? {} : { requestTtlMs: testing.requestTtlMs }),
    ended: (grantId) => files.remove(grantId),
    closeBrowser(grantId) {
      void context.services.browser
        ?.closeThread(`external:${grantId}`)
        .catch((error: unknown) =>
          context.log.log("warn", `Closing an outside client's tabs failed: ${String(error)}`),
        );
    },
    note: (text) => context.log.log("info", text),
    changed: () => toolsChanged?.(),
  });
  // Token files whose grants ended while the daemon was stopped.
  files.sweep((grantId) => outside.grants.live(grantId) !== undefined);
  let admit: (() => boolean) | undefined;
  // Tailscale and ace's relay as the server sees them, once it listens.
  let listening: { outsideReach(): ReachFacts } | undefined;
  const reach = (): ReachFacts => listening?.outsideReach() ?? unreachable;
  context.onListen.push((server) => {
    admit = () => server.maintenance.admit();
    listening = server;
  });
  const reachSettings = await outsideReachSettings(context);
  const oauth = outsideOAuth({
    outside,
    sql,
    now: context.now,
    random: randomBytes,
    after: nodeScheduler.after,
    fetchMetadata: testing?.fetchClientMetadata ?? publicMetadataFetch(),
    machine: reachSettings.machine,
    note: (text) => context.log.log("info", text),
  });
  const live = (threadId: string) => {
    const id = grantOfCaller(threadId);
    return id === undefined ? undefined : outside.grants.live(id);
  };
  const registry = externalTools(
    context,
    outside.grants,
    () => !context.signal.aborted && (admit?.() ?? false),
    // Stop on the screen line ends this client's screen calls at once.
    (_tool, capability, caller) => {
      if (capability !== "screen") return undefined;
      const grant = live(caller.threadId);
      return grant ? outside.screen.signal(grant.id, grant.name) : undefined;
    },
  );
  if (context.services.browser)
    outsideBrowserToolkit(context.services.browser, context.store, outside.grants).register(
      registry,
    );
  daemonComputerToolkit(context.services, context.services.computer, undefined, (threadId, app) => {
    const grant = live(threadId);
    return grant ? outside.screen.begin(grant.id, grant.name, app) : () => {};
  }).register(registry);
  const ports = endpointPort(context.config.dataDir);
  const saved = ports.read();
  let port = saved ?? 0;
  const server = await startMcpServer({
    registry,
    ...(saved === undefined ? {} : { port: saved }),
    onPortTaken: (taken) =>
      context.log.log(
        "warn",
        `The outside MCP endpoint's port ${taken} is taken; it moves to a new one, and pasted client configs need the new URL from ace mcp list.`,
      ),
    credentials: outside.principals,
    // Loopback requests: this endpoint's own address, or the person's public URL by its Host.
    loopback: async (request, serve) => {
      const base = loopbackBase(request.headers.get("host"), port, reachSettings.current().custom);
      return base ? oauth(request, base, serve) : new Response("Host not allowed", { status: 403 });
    },
    challenge: {
      // Challenges point at the metadata of the URL the request came in on (RFC 9728 §5.1).
      parameters: (resource): Record<string, string> =>
        resource
          ? { resource_metadata: resourceMetadataUrl(baseOfResource("local", resource)) }
          : {},
      missingScope(principal, tool, args) {
        const grant = live(principal.scope.threadId);
        return grant ? missingScope(grant.scopes, tool, args) : undefined;
      },
    },
    status: (caller) => {
      const scopes = live(caller.threadId)?.scopes ?? [];
      const lacks = (scope: OutsideScope) => !scopes.includes(scope);
      return {
        access: lacks("threads:start") && lacks("threads:message") ? "read-only" : null,
        unavailableTools: [
          ...withheldTools(scopes, registry.names()),
          ...(context.services.computer ? [] : computerToolNames),
        ],
        disabled: {
          ...(lacks("browser") ? { browser: "This grant doesn't include the browser." } : {}),
          ...(lacks("computer") ? { screen: "This grant doesn't include computer use." } : {}),
        },
        offReasons: {
          // This endpoint registers a fixed subset of ace's tools, whatever the daemon runs.
          unregistered:
            "ace offers this tool group to agents in ace threads, not to external MCP clients.",
          withheld:
            "This grant doesn't include it; the person can widen the grant in ace (or ace mcp enroll --allow).",
        },
      };
    },
  });
  toolsChanged = () => server.toolsChanged();
  port = Number(new URL(server.url).port);
  if (port !== saved) ports.save(port);
  const serve: ResourceFetch = server.serve;
  // The ts.net base the Tailscale listener last accepted; it is the same for every request.
  let tailnet: OutsideBase | undefined;
  const onTailscale = await nodeListener((request) =>
    tailnet ? oauth(request, tailnet, serve) : Promise.resolve(new Response(null, { status: 404 })),
  );
  return {
    /** Grants, tokens, access requests and screen use, for the admin protocol and OAuth. */
    outside,
    url: server.url,
    /** Where outside clients can reach this machine: loopback, Tailscale, ace's relay, own URL. */
    endpoints: (): OutsideEndpoint[] =>
      reachEndpoints(server.url, reach(), reachSettings.current()),
    /** Requests ace's relay forwards (`remote.relayMcp` is checked before they get here). */
    relay: ((request, _signal, forwarded) => {
      const base = relayBase(forwarded);
      return base
        ? oauth(request, base, serve)
        : Promise.resolve(new Response(null, { status: 404 }));
    }) satisfies RelayHttpHandler,
    /**
     * A request on the Tailscale listener: served here when it is for outside clients at the
     * ts.net name with `remote.tailscaleMcp` on; false hands it back to the daemon's own routes.
     */
    tailscale(request: IncomingMessage, response: ServerResponse): boolean {
      const path = (request.url ?? "/").split("?")[0] ?? "/";
      if (!outsidePath(path)) return false;
      const socket = request.socket;
      const servername = socket instanceof TLSSocket ? socket.servername : null;
      const host = request.headers.host ?? null;
      const base = tailscaleBase(
        { host, servername: typeof servername === "string" ? servername : null },
        reach().tailscale(),
        reachSettings.current(),
      );
      if (!base) return false;
      tailnet = base;
      void onTailscale(request, response);
      return true;
    },
    /**
     * What this endpoint serves, as `ace capabilities` reports it: the server's own `context`
     * and tool search/dispatch, then every registered tool. Each client is offered only the
     * tools its grant's scopes allow.
     */
    tools: ["context", aceToolSearch, aceToolDispatch, ...registry.names()],
    async execute(
      operation: Extract<CliOperation, { op: `mcp.${string}` }>,
    ): Promise<AgentControlResult> {
      switch (operation.op) {
        case "mcp.list":
          return { ok: true, data: { url: server.url, grants: outside.grants.entries() } };
        case "mcp.revoke":
          // Name what was revoked, so the CLI has something to confirm.
          return outside.revoke(operation.id)
            ? { ok: true, data: { revoked: operation.id } }
            : { ok: false, code: "not_found" };
        case "mcp.enroll": {
          const projects = operation.projects ?? "all";
          if (
            projects !== "all" &&
            projects.some((id) => !context.store.getWorkspace(WorkspaceId.parse(id)))
          )
            return { ok: false, code: "not_found" };
          const grant = outside.grants.create({
            clientKind: "cli",
            clientId: "ace-cli",
            name: operation.name ?? "Terminal agent",
            domain: null,
            scopes: operation.allow ?? shorthandScopes(operation.scope ?? "read"),
            projects,
            expiresAt: operation.ttlMs === null ? null : context.now() + operation.ttlMs,
            approvedBy: "local",
          });
          const bearer = outside.tokens.issueBearer(grant);
          let credentialFile: string;
          try {
            credentialFile = files.write(grant.id, bearer);
          } catch (error) {
            outside.revoke(grant.id);
            throw error;
          }
          outside.principals.watch([grant]);
          return {
            ok: true,
            data: {
              id: grant.id,
              scopes: grant.scopes,
              projects: grant.projects,
              expiresAt: grant.expiresAt,
              bearer,
              url: server.url,
              credentialFile,
              setup: `export ACE_MCP_TOKEN="$(cat ${shellQuote(credentialFile)})"`,
              claude: `claude mcp add-json ace '${JSON.stringify({ type: "http", url: server.url, headers: { Authorization: "Bearer ${ACE_MCP_TOKEN}" } })}'`,
              codex: `[mcp_servers.ace]\nurl = "${server.url}"\nbearer_token_env_var = "ACE_MCP_TOKEN"`,
            },
          };
        }
      }
    },
    async close() {
      reachSettings.close();
      outside.close();
      await server.close();
    },
  };
}

const reachKeys = [
  "remote.tailscaleMcp",
  "remote.relayMcp",
  "remote.mcpPublicUrl",
  "host.displayName",
] as const;
/**
 * The person's reach choices and the machine's name, kept current from settings so each
 * request reads them without waiting.
 */
async function outsideReachSettings(context: ServiceContext) {
  let current: ReachSettings = { tailscale: false, relay: false, custom: null };
  const name = (await computerName().catch(() => undefined)) ?? "this computer";
  let display: string | undefined;
  const settings = context.services.settings;
  const read = async () => {
    const entries = (
      await settings?.read({ keys: [...reachKeys], scope: {} }).catch(() => undefined)
    )?.entries;
    const value = (key: (typeof reachKeys)[number]) =>
      entries?.find((entry) => entry.key === key)?.value;
    const custom = value("remote.mcpPublicUrl");
    const shown = value("host.displayName");
    current = {
      tailscale: value("remote.tailscaleMcp") === true,
      relay: value("remote.relayMcp") === true,
      custom: typeof custom === "string" ? custom : null,
    };
    display = typeof shown === "string" && shown ? shown : undefined;
  };
  await read();
  const stop = await settings
    ?.subscribe({ keys: [...reachKeys], scope: {} }, (event) => {
      if (event.type === "changed") void read();
    })
    .catch(() => undefined);
  return {
    current: () => current,
    machine: () => display ?? name,
    close: () => stop?.(),
  };
}
