import type { ClientApi } from "@ace/client";
import type {
  OutsideAccessDecision,
  OutsideAccessRequest,
  OutsideEndpoint,
  OutsideGrant,
  OutsideGrantEntry,
  OutsideProjects,
  OutsideScope,
  OutsideScreenUse,
} from "@ace/protocol";

/*
 * Outside MCP clients on one machine (ADR 0122), through that machine's own client
 * (`outside.request`), so a remote machine's grants are its own. Every operation needs
 * administrator access; a `forbidden` answer means this window can't manage them.
 */

let sequence = 0;
const timeoutMs = 15_000;

type Operation = Extract<
  Parameters<ClientApi["request"]>[0],
  { type: "outside.request" }
>["operation"];

async function outside(client: ClientApi, operation: Operation) {
  const reply = await client.request(
    { type: "outside.request", requestId: `outside-${++sequence}`, operation },
    { timeoutMs },
  );
  return reply.result;
}

export async function outsideGrants(client: ClientApi): Promise<OutsideGrantEntry[]> {
  const result = await outside(client, { op: "grants" });
  return result.kind === "grants" ? result.grants : [];
}

export async function outsideEndpoints(client: ClientApi): Promise<OutsideEndpoint[]> {
  const result = await outside(client, { op: "endpoints" });
  return result.kind === "endpoints" ? result.endpoints : [];
}

export async function revokeGrant(client: ClientApi, grantId: string): Promise<void> {
  await outside(client, { op: "revoke", grantId });
}

export interface GrantChange {
  scopes?: OutsideScope[];
  projects?: OutsideProjects;
  expiresAt?: number | null;
}

export async function updateGrant(
  client: ClientApi,
  grantId: string,
  change: GrantChange,
): Promise<OutsideGrant | undefined> {
  const result = await outside(client, { op: "update", grantId, ...change });
  return result.kind === "updated" ? result.grant : undefined;
}

export async function decideAccess(
  client: ClientApi,
  accessRequestId: string,
  choice: OutsideAccessDecision,
): Promise<void> {
  await outside(client, { op: "decide", accessRequestId, choice });
}

export async function stopScreen(client: ClientApi, grantId: string): Promise<void> {
  await outside(client, { op: "stopScreen", grantId });
}

export const outsideKeys = {
  grants: ["outside", "grants"] as const,
  endpoints: ["outside", "endpoints"] as const,
};

/** What a watching admin device is told: pending sign-ins and clients using the screen. */
export interface OutsideNow {
  access: readonly OutsideAccessRequest[];
  screen: readonly OutsideScreenUse[];
}

interface Watch {
  /** Undefined until told, while disconnected, and where this window isn't an administrator. */
  value: OutsideNow | undefined;
  listeners: Set<() => void>;
  /** Bumped on every connection change, so a reply from an earlier connection is dropped. */
  connection: number;
}

const watches = new WeakMap<ClientApi, Watch>();

function show(watch: Watch, value: OutsideNow | undefined) {
  watch.value = value;
  for (const listener of watch.listeners) listener();
}

/**
 * One watch per client: asked on every ready connection, kept current by `outside.state`. A
 * daemon that refuses (not an administrator) or predates outside clients shows nothing.
 */
export function watchOutside(client: ClientApi): Watch {
  const existing = watches.get(client);
  if (existing) return existing;
  const watch: Watch = { value: undefined, listeners: new Set(), connection: 0 };
  watches.set(client, watch);
  const ask = () => {
    if (client.state !== "ready") return;
    const asked = watch.connection;
    outside(client, { op: "watch" }).catch(() => {
      if (watch.connection === asked) show(watch, undefined);
    });
  };
  client.onMessage((message) => {
    if (message.type === "outside.state")
      show(watch, { access: message.access, screen: message.screen });
  });
  const connection = client.connectionState();
  let ready = client.state === "ready";
  connection.subscribe(() => {
    const now = connection.getSnapshot() === "ready";
    if (now === ready) return;
    ready = now;
    watch.connection += 1;
    // A daemon's watch ends with its socket: ask again, and show nothing until it answers.
    if (now) ask();
    else if (watch.value) show(watch, undefined);
  });
  ask();
  return watch;
}

/**
 * Calls `run` whenever a pending sign-in leaves the machine's list: approved or denied from any
 * device, or expired. An approval makes a grant, so a grants list reads again then. Returns a stop.
 */
export function onSignInsSettled(client: ClientApi, run: () => void): () => void {
  const watch = watchOutside(client);
  const ids = () => new Set(watch.value?.access.map((request) => request.requestId) ?? []);
  let seen = ids();
  const changed = () => {
    const now = ids();
    if ([...seen].some((id) => !now.has(id))) run();
    seen = now;
  };
  watch.listeners.add(changed);
  return () => void watch.listeners.delete(changed);
}

export function readOutside(client: ClientApi | undefined): OutsideNow | undefined {
  return client ? watches.get(client)?.value : undefined;
}
