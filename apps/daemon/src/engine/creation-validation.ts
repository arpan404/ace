import { portableContext } from "@ace/context";
import { supportsPermissionMode } from "@ace/core";
import { boundedJson } from "@ace/provider-kit/ipc";
import { AcpIdentity, type Command } from "@ace/protocol";
import { maxMessageBytes } from "./queue-store.ts";
import type { EngineRepository } from "./repository.ts";
import type { AdapterRegistry } from "./registry.ts";
import type { EngineLimits } from "./limits.ts";
import type { EngineOptions } from "./index.ts";

const fail = (error: string) => ({ ok: false as const, error });

/** Shared admission decision. Filesystem canonicalization is supplied by the I/O boundary. */
export function validateCreation(
  command: Command,
  repo: EngineRepository,
  registry: AdapterRegistry,
  limits: EngineLimits,
  directory: (path: string) => string,
  selectInstance?: EngineOptions["selectInstance"],
) {
  const p = command.payload;
  if (p.type !== "thread.create" && p.type !== "thread.prepare") return fail("invalid_command");
  if (p.threadId && repo.store.getThread(p.threadId)) return fail("thread_exists");
  try {
    if (p.type === "thread.create" && p.input.length > 64) return fail("message_too_large");
    boundedJson(command, maxMessageBytes);
  } catch {
    return fail("message_too_large");
  }
  let deliveryCommand = command;
  const identity = p.provider === "acp" ? AcpIdentity.safeParse(p) : undefined;
  if (p.provider === "acp" && !identity?.success) return fail("acp_identity_required");
  const acpIdentity = identity?.success ? identity.data : undefined;
  if (!registry.has(p.provider, acpIdentity)) return fail("provider_unavailable");
  const path = repo.workspace(p.workspaceId);
  if (!path) return fail("workspace_not_found");
  let cwd: string;
  try {
    cwd = directory(path);
  } catch {
    return fail("workspace_unavailable");
  }
  if (repo.store.workspaceReservations.reserved(cwd)) return fail("workspace_change_in_progress");
  const entry = registry.get(p.provider);
  if (p.permissionMode && !supportsPermissionMode(entry.capabilities.permissions, p.permissionMode))
    return fail("permission_mode_unsupported");
  const accountId = p.accountId ?? ("account" in p ? p.account : undefined);
  if (p.type === "thread.create" && p.instanceId && accountId && p.instanceId !== accountId)
    return fail("conflicting_account_selection");
  const instanceId =
    (p.type === "thread.create" ? p.instanceId : undefined) ??
    accountId ??
    selectInstance?.(p.provider, entry.adapter.backend);
  let handoff: ReturnType<typeof portableContext> | undefined;
  if (p.handoffFrom) {
    const source = repo.store.getThread(p.handoffFrom);
    if (!source) return fail("handoff_source_not_found");
    const page = repo.store.readItemPage(p.handoffFrom, Number.MAX_SAFE_INTEGER, 100, 262144);
    handoff = portableContext(
      {
        threadId: source.id,
        provider: source.provider,
        throughSeq: page.seq,
        totalItems: repo.store.historicalItemCount(source.id, page.seq),
        ...((source.backend ?? (source.provider === "cursor" ? "acp" : undefined))
          ? { backend: source.backend ?? "acp" }
          : {}),
      },
      page.items,
      { maxBytes: 65536, maxItems: 100, historyTruncated: page.itemsBefore !== null },
    );
    if (p.type === "thread.create")
      deliveryCommand = {
        ...command,
        payload: { ...p, input: [{ type: "text", text: handoff.text }, ...p.input] },
      };
  }
  try {
    boundedJson(deliveryCommand, maxMessageBytes);
  } catch {
    return fail("queue_capacity_exceeded");
  }
  if (entry.adapter.backend === "cursor-sdk") {
    try {
      const input = deliveryCommand.payload;
      if (input.type === "thread.create") boundedJson(input.input, limits.maxInputBytes);
    } catch {
      return fail("provider_input_budget_exceeded");
    }
  }
  if (
    p.options &&
    Object.keys(p.options)
      .filter((key) => key === "effort" || key === "serviceTier")
      .some(
        (option) =>
          !registry
            .get(p.provider)
            .capabilities.launchOptions?.some((supported) => supported === option),
      )
  )
    return fail("launch_options_unsupported");

  return { ok: true as const, cwd, entry, acpIdentity, instanceId, handoff, deliveryCommand };
}
