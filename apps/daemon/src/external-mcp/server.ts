import { aceToolDispatch, aceToolSearch, nodeScheduler, startMcpServer } from "@ace/mcp-server";
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
import { alertAccessRequests } from "./access-alerts.ts";
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
  const outside = new OutsideAccess({
    sql: {
      statement: (text) => context.store.statement(text),
      atomic: (run) => context.store.atomic(() => run()),
    },
    now: context.now,
    id: context.id,
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
  // Each sign-in request reaches admin phones by push too, in case ace isn't open on them.
  const stopAlerts = alertAccessRequests(outside.requests, {
    devices: () => context.store.devices.list(),
    now: context.now,
    addresses: async (devices) => (await context.services.accessPush?.addresses(devices)) ?? [],
    send: (device, alert, signal) =>
      context.services.accessPush?.send(device, alert, signal) ?? Promise.resolve("failed"),
    after: nodeScheduler.after,
    report: (error) =>
      context.log.log("warn", `A sign-in request's push alert failed: ${String(error)}`),
  });
  // Token files whose grants ended while the daemon was stopped.
  files.sweep((grantId) => outside.grants.live(grantId) !== undefined);
  let admit: (() => boolean) | undefined;
  context.onListen.push((server) => {
    admit = () => server.maintenance.admit();
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
  const server = await startMcpServer({
    registry,
    ...(saved === undefined ? {} : { port: saved }),
    onPortTaken: (port) =>
      context.log.log(
        "warn",
        `The outside MCP endpoint's port ${port} is taken; it moves to a new one, and pasted client configs need the new URL from ace mcp list.`,
      ),
    credentials: outside.principals,
    challenge: {
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
  const port = Number(new URL(server.url).port);
  if (port !== saved) ports.save(port);
  return {
    /** Grants, tokens, access requests and screen use, for the admin protocol and OAuth. */
    outside,
    url: server.url,
    /** Where outside clients can reach this machine, best first. The OAuth task adds the rest. */
    endpoints: (): OutsideEndpoint[] => [{ path: "local", url: server.url, on: true }],
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
      stopAlerts();
      outside.close();
      await server.close();
    },
  };
}
