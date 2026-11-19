import { z } from "zod";
import type { Client } from "@ace/client";
import {
  CliOperation,
  OutsideAccessRequest,
  OutsideGrantEntry,
  OutsideProjects,
} from "@ace/protocol";
import { option, type Args } from "./args.ts";
import { emit } from "./io.ts";
import { CliFailure, usageFailure } from "./output.ts";
import { grantIds, mcpAddedLines, mcpListLines, mcpRequestLines } from "./render/mcp.ts";

/** Outside MCP clients (ADR 0122): grants made here, and clients asking to sign in. */

const Enrolled = z.looseObject({
  id: z.string(),
  expiresAt: z.number().nullable(),
  setup: z.string(),
  claude: z.string(),
  codex: z.string(),
});
const AccessRequests = z.array(OutsideAccessRequest);
const Listed = z.looseObject({ url: z.string(), grants: z.array(OutsideGrantEntry) });

/** `--ttl` for a grant: `30m`, `12h`, `30d`, or `never` (null). Pure. */
export function grantLifetimeMs(value: string): number | null {
  if (value === "never") return null;
  const match = /^(\d{1,4})(m|h|d)$/.exec(value);
  if (!match || Number(match[1]) === 0)
    throw usageFailure("--ttl takes minutes, hours or days (30m, 12h, 30d), or never.", {
      argument: "--ttl",
    });
  const scale = match[2] === "d" ? 86_400_000 : match[2] === "h" ? 3_600_000 : 60_000;
  return Number(match[1]) * scale;
}

function list(args: Args, name: string): string[] | undefined {
  return option(args, name)
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function mcpGrantCommand(
  args: Args,
  client: Client,
  signal: AbortSignal,
  verb: "list" | "add" | "revoke",
  now: () => number = Date.now,
) {
  if (verb === "add" && !option(args, "ttl"))
    throw usageFailure("ace mcp add needs --ttl: how long the client keeps access.", {
      code: "missing_argument",
      argument: "--ttl",
      hint: "For example --ttl 30d, or --ttl never.",
    });
  if (verb === "add" && option(args, "scope") && option(args, "allow"))
    throw usageFailure("Pass --scope or --allow, not both.", { argument: "--allow" });
  const operation = CliOperation.parse(
    verb === "add"
      ? {
          op: "mcp.enroll",
          scope: option(args, "scope"),
          allow: list(args, "allow"),
          ttlMs: grantLifetimeMs(option(args, "ttl") ?? "1h"),
          projects: list(args, "project"),
          name: option(args, "name"),
        }
      : verb === "list"
        ? { op: "mcp.list" }
        : { op: "mcp.revoke", id: args.words[0] },
  );
  const response = await client.request({ type: "cli.request", operation }, { signal });
  if (!response.result.ok) {
    if (verb === "revoke" && response.result.code === "not_found")
      throw new CliFailure(
        "refused",
        `No grant ${args.words[0]}: it ended or was revoked.`,
        undefined,
        {
          code: "not_found",
          hint: "See the grants with ace mcp list.",
        },
      );
    throw new CliFailure("refused", `The daemon refused: ${response.result.code ?? "refused"}.`);
  }
  const data = response.result.data;
  if (verb === "list")
    return emit(args, Listed.parse(data), {
      human: (value) => mcpListLines(value, now()),
      quiet: (value) => grantIds(value, now()),
    });
  if (verb === "add")
    return emit(args, Enrolled.parse(data), { human: mcpAddedLines, quiet: (value) => [value.id] });
  return emit(args, data, { human: () => `Revoked ${args.words[0]}.`, quiet: () => [] });
}

/** The pending sign-ins: ask the daemon to watch, and take the first state it pushes. */
async function pendingRequests(client: Client, signal: AbortSignal) {
  const state = new Promise<OutsideAccessRequest[]>((resolve) => {
    const stop = client.onMessage((message) => {
      if (message.type !== "outside.state") return;
      stop();
      resolve(AccessRequests.parse(message.access));
    });
    signal.addEventListener("abort", stop, { once: true });
  });
  await client.request({ type: "outside.request", operation: { op: "watch" } }, { signal });
  return state;
}

/** `ace mcp request list|allow|deny`: the person answers a client's sign-in (ADR 0122). */
export async function mcpRequestCommand(
  args: Args,
  client: Client,
  signal: AbortSignal,
  verb: "list" | "allow" | "deny",
  now: () => number = Date.now,
) {
  const requests = await pendingRequests(client, signal);
  if (verb === "list")
    return emit(
      args,
      { requests },
      {
        human: (value) => mcpRequestLines(value, now()),
        quiet: (value) => value.requests.map((request) => request.requestId),
      },
    );
  const id = args.words[0] ?? "";
  const request = requests.find((entry) => entry.requestId === id);
  if (!request)
    throw new CliFailure("refused", `No client is asking to sign in as ${id}.`, undefined, {
      code: "not_found",
      hint: "It may have expired. See the requests with ace mcp request list.",
    });
  const lifetime = grantLifetimeMs(option(args, "ttl") ?? "30d");
  const projects = list(args, "project");
  const choice =
    verb === "deny"
      ? { decision: "deny" as const }
      : {
          decision: "approve" as const,
          scopes: request.scopes,
          projects: OutsideProjects.parse(projects?.length ? projects : "all"),
          expiresAt: lifetime === null ? null : now() + lifetime,
        };
  await client.request(
    {
      type: "outside.request",
      operation: { op: "decide", accessRequestId: request.requestId, choice },
    },
    { signal },
  );
  return emit(
    args,
    { request: request.requestId, decision: verb },
    {
      human: () =>
        verb === "allow"
          ? `Allowed ${request.clientName}. See its grant with ace mcp list.`
          : `Turned ${request.clientName} away.`,
      quiet: () => [],
    },
  );
}
