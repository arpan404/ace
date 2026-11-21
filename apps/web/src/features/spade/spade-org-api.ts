import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { useMachines } from "@/lib/machines.ts";
import { spadeMachineKey, useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { segment, spadeHttp, SpadeRequestError, type SpadeTarget } from "./spade-requests.ts";

/*
 * Spade on an org host (ADR 0206 §2.3, §4.2): the organization it belongs to (`GET /v1/org`), a
 * shared bot's access list (`GET /v1/agents/{id}/access`) and the host's audit log as JSON Lines
 * (`GET /v1/org/audit/export`). A personal machine's Spade belongs to no organization.
 */

const OrgView = z.object({
  org: z.string().max(128).nullable(),
  name: z.string().max(256).optional(),
  host: z.string().max(128).optional(),
  policy: z.number().int().nonnegative().optional(),
  auditKey: z.string().max(128).nullable().optional(),
});
export type SpadeOrgView = z.infer<typeof OrgView>;

const Access = z.object({
  org: z.string().max(128),
  maker: z.string().max(256),
  /** Undefined: every member may talk to it. */
  talk: z.array(z.string().max(256)).max(200).optional(),
  approvers: z.array(z.string().max(256)).max(200),
  configurers: z.array(z.string().max(256)).max(200).optional(),
});
export type SpadeSharedAccess = z.infer<typeof Access>;

export async function readSpadeOrg(target: SpadeTarget, signal?: AbortSignal) {
  return OrgView.parse(JSON.parse(await spadeHttp(target, "GET", "/v1/org", { signal })));
}

/** A bot's access list, or undefined for a bot that isn't shared. */
export async function readSharedAccess(
  target: SpadeTarget,
  agent: string,
  signal?: AbortSignal,
): Promise<SpadeSharedAccess | undefined> {
  try {
    const text = await spadeHttp(target, "GET", `/v1/agents/${segment(agent)}/access`, { signal });
    return z.object({ access: Access }).parse(JSON.parse(text)).access;
  } catch (error) {
    if (error instanceof SpadeRequestError && error.status === 404) return undefined;
    throw error;
  }
}

/** The host's log from `from` through `to` (ms), as Spade exports it. */
export async function readAuditExport(
  target: SpadeTarget,
  span: { from?: number; to?: number },
  signal?: AbortSignal,
): Promise<string> {
  const query = new URLSearchParams();
  if (span.from !== undefined) query.set("from", String(span.from));
  if (span.to !== undefined) query.set("to", String(span.to));
  const path = `/v1/org/audit/export${query.size ? `?${query}` : ""}`;
  return spadeHttp(target, "GET", path, { signal });
}

/** Every org read of Spade's; one machine's under `[...spadeOrgKey, machine key]`. */
export const spadeOrgKey = ["spade", "org"] as const;

/** The organization a machine's Spade belongs to, if any; nothing while it is offline. */
export function useSpadeOrgOn(machine: string, client: SpadeTarget | undefined) {
  return useQuery({
    queryKey: [...spadeOrgKey, machine],
    queryFn: ({ signal }) =>
      client ? readSpadeOrg(client, signal) : Promise.reject(new Error("offline")),
    enabled: client !== undefined,
    staleTime: 60_000,
    retry: false,
  });
}

/** The organization the machine in scope's Spade belongs to, if any. */
export function useSpadeOrg() {
  return useSpadeOrgOn(useSpadeMachine().key, useSpadeClient());
}

/**
 * A bot as shared on its org host (ADR 0206 §2.3): its organization's name and access list, or
 * undefined for a bot on a personal machine or one that isn't shared. A personal machine is asked
 * only `GET /v1/org`, once a minute at most.
 */
export function useBotSharing(bot: { id: string; machine: { key: string } }) {
  const client = useMachines().find(
    (machine) => spadeMachineKey(machine) === bot.machine.key,
  )?.client;
  const org = useSpadeOrgOn(bot.machine.key, client).data;
  const bound = typeof org?.org === "string";
  const access = useQuery({
    queryKey: [...spadeOrgKey, bot.machine.key, "access", bot.id],
    queryFn: ({ signal }) =>
      client ? readSharedAccess(client, bot.id, signal) : Promise.resolve(undefined),
    enabled: bound && client !== undefined,
    staleTime: 30_000,
    retry: false,
  }).data;
  if (!bound || !access) return undefined;
  return { orgName: org?.name || "your organization", access };
}
