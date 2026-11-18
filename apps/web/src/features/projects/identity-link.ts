import type { ClientApi } from "@ace/client";
import { WorkspaceId, type CommandPayload } from "@ace/protocol";
import { groupOf, type ProjectGroup } from "@ace/ui-core/project-groups";

/*
 * Linking two checkouts into one logical project (ADR 0180), planned apart from sending so the
 * plan can be tested and a half-done link retried as the same plan.
 */

/** One checkout, by machine and its project id there. */
export interface CheckoutRef {
  machineId: string;
  workspaceId: string;
}

/** One command to one machine. */
export interface LinkStep {
  machineId: string;
  payload: CommandPayload;
}

export interface LinkPlan {
  /** The logical project both end up in. */
  identityId: string;
  steps: LinkStep[];
}

const idOf = (groups: readonly ProjectGroup[], checkout: CheckoutRef) =>
  groupOf(groups, checkout.machineId, checkout.workspaceId)?.checkouts.find(
    (each) => each.workspaceId === checkout.workspaceId && each.machineId === checkout.machineId,
  )?.identityId;

/**
 * What linking `b` into `a`'s logical project sends. A checkout without an identity is linked
 * to the other's, or both to a new one (`newId`, the caller's UUID source) when neither has one.
 * Two that each have one merge: every id of `b`'s group into `a`'s, on every machine that keeps
 * identities (`machines`), so the alias reaches as many as it can. Already one: nothing.
 */
export function linkPlan(
  groups: readonly ProjectGroup[],
  a: CheckoutRef,
  b: CheckoutRef,
  machines: readonly string[],
  newId: () => string,
): LinkPlan {
  const groupA = groupOf(groups, a.machineId, a.workspaceId);
  const groupB = groupOf(groups, b.machineId, b.workspaceId);
  const idA = idOf(groups, a);
  const idB = idOf(groups, b);
  if (groupA && groupA === groupB && idA) return { identityId: idA, steps: [] };
  const link = (checkout: CheckoutRef, identityId: string): LinkStep => ({
    machineId: checkout.machineId,
    payload: {
      type: "workspace.identity.link",
      workspaceId: WorkspaceId.parse(checkout.workspaceId),
      identityId,
    },
  });
  if (!idA && !idB) {
    const identityId = newId();
    return { identityId, steps: [link(a, identityId), link(b, identityId)] };
  }
  if (idA && !idB) return { identityId: idA, steps: [link(b, idA)] };
  if (!idA && idB) return { identityId: idB, steps: [link(a, idB)] };
  const into = idA ?? "";
  const known = new Set(groupA?.identityIds ?? [into]);
  const merged = (groupB?.identityIds ?? [idB ?? ""]).filter((id) => id && !known.has(id));
  return {
    identityId: into,
    steps: machines.flatMap((machineId) =>
      merged.map((from): LinkStep => ({
        machineId,
        payload: { type: "workspace.identity.merge", from, into },
      })),
    ),
  };
}

/**
 * Linking `b` into `a`'s logical project when only `b`'s project marker says they are one
 * (ADR 0181): `b` alone is linked, recorded as through a marker, so it is never where a transfer
 * lands; nothing is merged on the strength of a file anyone can copy. `a` gets an identity first
 * when it has none (`newId`).
 */
export function markerLinkPlan(
  groups: readonly ProjectGroup[],
  a: CheckoutRef,
  b: CheckoutRef,
  newId: () => string,
): LinkPlan {
  const idA = idOf(groups, a);
  const identityId = idA ?? newId();
  const link = (checkout: CheckoutRef, viaMarker: boolean): LinkStep => ({
    machineId: checkout.machineId,
    payload: {
      type: "workspace.identity.link",
      workspaceId: WorkspaceId.parse(checkout.workspaceId),
      identityId,
      ...(viaMarker ? { viaMarker: true as const } : {}),
    },
  });
  return { identityId, steps: [...(idA ? [] : [link(a, false)]), link(b, true)] };
}

/**
 * Send each step to its machine; the machines whose step was refused or didn't answer. A step
 * repeats harmlessly (link and merge are idempotent), so a retry sends the whole plan again.
 */
export async function runLinkPlan(
  plan: LinkPlan,
  client: (machineId: string) => ClientApi | undefined,
): Promise<string[]> {
  const failed = new Set<string>();
  await Promise.all(
    plan.steps.map(async (step) => {
      const target = client(step.machineId);
      try {
        const result = await target?.command(step.payload);
        if (!result?.ok) failed.add(step.machineId);
      } catch {
        failed.add(step.machineId);
      }
    }),
  );
  return [...failed];
}

/** Whether a machine keeps identities: an older daemon refuses the request it doesn't know. */
export async function keepsIdentities(client: ClientApi): Promise<boolean> {
  try {
    const reply = await client.request({
      type: "workspace.request",
      operation: { op: "workspaces.identitySuggestions", remotes: [], subpath: "", limit: 1 },
    });
    return reply.result.kind === "identitySuggestions";
  } catch {
    return false;
  }
}
