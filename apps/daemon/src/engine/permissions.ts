import { reportedOrTable, stricterOffer } from "@ace/provider-kit/access-modes";
import {
  AccessMode,
  PermissionPolicyIdentity,
  AcpIdentity,
  ThreadId as importThreadId,
  type AccessModeOffer,
  type AccessRequest,
  type PermissionMode,
  type PermissionState,
  type ThreadId,
  type Command,
  type CommandResult,
  type Capabilities,
  type EventPayload,
  type ProviderKind,
} from "@ace/protocol";
import { supportsPermissionMode, type ThreadState } from "@ace/core";
import type { EngineRepository } from "./repository.ts";
import {
  allowedChildModes,
  ceilingMode,
  customNative,
  customSelection,
  inheritedPermissionMode,
  permissionWithinCeiling,
  type AccessSelection,
} from "./permission-ceiling.ts";
import {
  PermissionRecord,
  createPermissionTables,
  migratePermissions,
  migrateRecordedPermissionStates,
  permissionState,
} from "./permission-storage.ts";
import { reviewAceToolConsent } from "./permission-reviews.ts";

export interface CeilingRefusal {
  provider: ProviderKind;
  mode: AccessSelection | null;
  allowed: AccessMode[];
  /** Why: the request is broader than the parent, or the target doesn't offer it. */
  reason: "access_escalation_denied" | "access_unavailable" | "permission_ceiling_unverifiable";
  offered: AccessMode[];
}
/** The defaults a thread without its own choice follows: project, then this daemon. */
export interface AccessDefaults {
  access: AccessMode;
  /** Settings → Providers → Advanced: a native mode the provider runs instead (Custom). */
  custom?: PermissionMode;
}
export type PermissionSettings = (id: ThreadId) => Promise<AccessDefaults>;
export interface ResolvedAccess {
  selection: AccessSelection | null;
  native: PermissionMode | null;
}
export class AccessError extends Error {
  readonly code: CeilingRefusal["reason"] | "access_mode_unavailable";
  constructor(code: AccessError["code"], detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}
const offersOf = (
  provider: ProviderKind,
  capabilities: Capabilities | undefined,
): AccessModeOffer[] => reportedOrTable(provider, capabilities?.accessModes);
export function nativeFor(
  selection: AccessSelection | null,
  offers: readonly AccessModeOffer[],
): PermissionMode | null {
  if (selection === null) return null;
  return (
    customNative(selection) ?? offers.find((offer) => offer.mode === selection)?.native ?? null
  );
}

/** Durable access ownership (ADR 0075): ace modes per thread, native selectors at the edge. */
export class Permissions {
  private repo: EngineRepository;
  constructor(repo: EngineRepository) {
    this.repo = repo;
    createPermissionTables(repo);
    migrateRecordedPermissionStates(repo);
    migratePermissions(repo);
  }
  private read(id: ThreadId): PermissionRecord {
    const row = this.repo.store.atomic((db) =>
      db
        .prepare(
          "SELECT override,effective,parent,ceiling_provider,ceiling_mode,ceiling_identity FROM engine_permissions WHERE thread_id=?",
        )
        .get(id),
    );
    return row
      ? PermissionRecord.parse(row)
      : {
          override: null,
          effective: null,
          parent: null,
          ceiling_provider: null,
          ceiling_mode: null,
          ceiling_identity: null,
        };
  }
  private offers(id: ThreadId): AccessModeOffer[] {
    const thread = this.repo.store.getThread(id);
    return offersOf(
      thread?.provider ?? this.repo.requireState(id).config.provider,
      thread?.effectiveCapabilities ?? thread?.capabilities,
    );
  }
  ensure(id: ThreadId, override?: AccessMode): PermissionState {
    this.repo.store.atomic((db) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO engine_permissions(thread_id,override,effective,parent) VALUES (?,?,?,NULL)",
        )
        .run(id, override ?? null, override ?? null),
    );
    return this.state(id);
  }
  effective(id: ThreadId): AccessSelection | null {
    return this.read(id).effective;
  }
  /** Whether the thread runs in Full access. */
  private fullAccess(id: ThreadId): boolean {
    return this.read(id).effective === "full-access";
  }
  /** ace-owned Mac tools have their own manual consent, independent of the harness mode. */
  authority(_id: ThreadId): PermissionMode {
    return "ask";
  }
  state(id: ThreadId): PermissionState {
    return permissionState(this.read(id));
  }
  parent(child: ThreadId, parent: ThreadId, _at: number): void {
    if (child === parent) throw new Error("Permission ancestry cycle");
    this.ensure(child);
    const provider = this.repo.store.getThread(parent)?.provider;
    if (!provider) throw new Error("permission_parent_not_found");
    const identity = this.identity(parent, provider);
    const mode = this.ceilingSelection(parent);
    this.repo.store.atomic((db) => {
      const existing = this.read(child);
      if (existing.parent && existing.parent !== parent)
        throw new Error("Permission owner conflict");
      if (!existing.parent)
        db.prepare(
          "UPDATE engine_permissions SET parent=?,ceiling_provider=?,ceiling_mode=?,ceiling_identity=? WHERE thread_id=?",
        ).run(parent, provider, mode, JSON.stringify(identity), child);
    });
  }
  /** `selected` within this thread's ancestry, stepped down to a stricter offered mode if needed. */
  private contained(
    id: ThreadId,
    provider: ProviderKind,
    selected: AccessSelection | null,
    offers: readonly AccessModeOffer[],
    depth = 0,
  ): AccessSelection | null {
    const record = this.read(id);
    if (!record.parent) return selected;
    if (depth >= 64) throw new Error("Permission ancestry exceeds capacity");
    const identity = this.identity(id, provider);
    const ceiling = this.ceiling(importThreadId.parse(record.parent), depth + 1);
    let mode = selected;
    if (!permissionWithinCeiling(ceiling, { ...identity, mode })) {
      const inherited = inheritedPermissionMode(ceiling, identity, offers);
      if (inherited === undefined) throw new Error("permission_ceiling_unverifiable");
      mode = inherited;
    }
    if (
      !record.ceiling_identity ||
      !permissionWithinCeiling(
        {
          ...PermissionPolicyIdentity.parse(JSON.parse(record.ceiling_identity)),
          mode: record.ceiling_mode,
        },
        { ...identity, mode },
      )
    )
      throw new Error("permission_ceiling_unverifiable");
    return mode;
  }
  private identity(id: ThreadId, provider: ProviderKind): PermissionPolicyIdentity {
    const thread = this.repo.store.getThread(id);
    if (!thread) throw new Error("permission_thread_not_found");
    return PermissionPolicyIdentity.parse({
      provider,
      backend: this.repo.backend(id),
      ...(provider === "acp"
        ? {
            ...AcpIdentity.parse(thread),
            instanceId: this.repo.session(id).instanceId ?? thread.instanceId,
          }
        : { instanceId: this.repo.session(id).instanceId ?? `${provider}-cli-default` }),
    });
  }
  /** A thread's own mode for its children: the stricter side of a pending change. */
  private ceilingSelection(id: ThreadId) {
    const record = this.read(id);
    return ceilingMode(record.effective, record.override);
  }
  /** The policy `parentId`'s children are contained by, its ancestors included. */
  private ceiling(parentId: ThreadId, depth = 0) {
    const parent = this.repo.store.getThread(parentId);
    if (!parent) throw new Error("permission_parent_not_found");
    const identity = this.identity(parentId, parent.provider);
    const selected = this.ceilingSelection(parentId);
    return {
      ...identity,
      mode: this.contained(parentId, parent.provider, selected, this.offers(parentId), depth),
    };
  }
  /** Why a child's access was refused, with the modes the target would accept. */
  refusal(
    parentId: ThreadId,
    identity: PermissionPolicyIdentity,
    offers: readonly AccessModeOffer[],
    requested?: AccessRequest,
  ): CeilingRefusal | undefined {
    try {
      const ceiling = this.ceiling(parentId);
      const allowed = allowedChildModes(ceiling, offers);
      const offered = offers.map((offer) => offer.mode);
      const reason =
        requested !== undefined && requested !== "inherit" && !offered.includes(requested)
          ? "access_unavailable"
          : requested !== undefined && requested !== "inherit"
            ? "access_escalation_denied"
            : "permission_ceiling_unverifiable";
      return { provider: ceiling.provider, mode: ceiling.mode, allowed, reason, offered };
    } catch {
      return undefined;
    }
  }
  /**
   * A child's access under `parentId`. Inherit takes the broadest offered mode at or below the
   * parent's; an explicit mode must be offered and no broader than the parent's.
   */
  narrow(
    parentId: ThreadId,
    identity: PermissionPolicyIdentity,
    requested: AccessRequest | undefined,
    offers: readonly AccessModeOffer[],
  ): AccessSelection | null {
    const ceiling = this.ceiling(parentId);
    if (requested === undefined || requested === "inherit") {
      const inherited = inheritedPermissionMode(ceiling, identity, offers);
      if (inherited === undefined)
        throw new AccessError("permission_ceiling_unverifiable", "no offered mode fits");
      return inherited;
    }
    if (!offers.some((offer) => offer.mode === requested))
      throw new AccessError(
        "access_unavailable",
        `${identity.provider} doesn't offer ${requested}`,
      );
    if (!permissionWithinCeiling(ceiling, { ...identity, mode: requested }))
      throw new AccessError("access_escalation_denied", `${requested} exceeds the parent`);
    return requested;
  }
  set(
    id: ThreadId,
    access: AccessMode | null,
    capabilities: Capabilities,
    at: number,
  ): string | undefined {
    if (
      access &&
      !offersOf(this.repo.requireState(id).config.provider, capabilities).some(
        (offer) => offer.mode === access,
      )
    )
      return "permission_mode_unsupported";
    const provider = this.repo.requireState(id).config.provider;
    if (this.read(id).parent && access) {
      try {
        if (this.contained(id, provider, access, offersOf(provider, capabilities)) !== access)
          return "permission_ceiling_unverifiable";
      } catch {
        return "permission_ceiling_unverifiable";
      }
    }
    this.ensure(id);
    this.repo.store.atomic((db) =>
      db.prepare("UPDATE engine_permissions SET override=? WHERE thread_id=?").run(access, id),
    );
    this.repo.store.appendEvents(
      id,
      [{ type: "thread.updated", permission: { ...this.state(id), pending: true } }],
      at,
    );
    return undefined;
  }
  /**
   * What the thread runs next: an Advanced native override, else its own mode, else the
   * project's and daemon's default, stepped down to the nearest stricter mode the provider
   * offers, then contained by its ancestry. A provider with no ace modes runs its default.
   */
  async resolve(
    id: ThreadId,
    settings?: PermissionSettings,
    nativeCapabilities?: Capabilities,
  ): Promise<ResolvedAccess> {
    const provider = this.repo.requireState(id).config.provider;
    const defaults = (await settings?.(id)) ?? { access: "auto-review" as const };
    const thread = this.repo.store.getThread(id);
    const capabilities =
      nativeCapabilities ?? thread?.effectiveCapabilities ?? thread?.capabilities;
    const offers = offersOf(provider, capabilities);
    let selection: AccessSelection | null;
    if (defaults.custom && supportsPermissionMode(capabilities, defaults.custom))
      selection = customSelection(defaults.custom);
    else if (!offers.length) selection = null;
    else {
      const requested = AccessMode.safeParse(this.read(id).override);
      const target = requested.success ? requested.data : defaults.access;
      const offer = stricterOffer(target, offers);
      if (!offer)
        throw new AccessError(
          "access_mode_unavailable",
          `${provider} offers no mode as strict as ${target}; choose one of ${offers.map((o) => o.mode).join(", ")}`,
        );
      selection = offer.mode;
    }
    selection = this.contained(id, provider, selection, offers);
    return { selection, native: nativeFor(selection, offers) };
  }
  applied(id: ThreadId, selection: AccessSelection | null, at: number): void {
    const provider = this.repo.requireState(id).config.provider;
    const mode = this.contained(id, provider, selection, this.offers(id));
    this.ensure(id);
    this.repo.store.atomic(() => {
      this.repo.store.atomic((db) =>
        db.prepare("UPDATE engine_permissions SET effective=? WHERE thread_id=?").run(mode, id),
      );
      this.repo.store.appendEvents(
        id,
        [{ type: "thread.updated", permission: this.state(id) }],
        at,
      );
    });
  }
  /** A provider acknowledged a native selector (Codex reports each turn's). */
  appliedNative(
    id: ThreadId,
    native: PermissionMode | null,
    capabilities: Capabilities | undefined,
    at: number,
  ): void {
    const offer = offersOf(this.repo.requireState(id).config.provider, capabilities).find(
      (entry) => entry.native === native,
    );
    this.applied(id, offer ? offer.mode : native === null ? null : customSelection(native), at);
  }
  validateIdentity(id: ThreadId, selection: AccessSelection | null): void {
    const provider = this.repo.requireState(id).config.provider;
    if (this.contained(id, provider, selection, this.offers(id)) !== selection)
      throw new Error("permission_ceiling_unverifiable");
  }
  observe(state: ThreadState, events: EventPayload[], at: number, wake: () => void): void {
    // A provider asking about ace's own tool in Full access answers itself; ace's consent for
    // origins, apps and devices still asks inside the tool, in every mode.
    const mode = this.fullAccess(state.threadId) ? "full-access" : "ask";
    reviewAceToolConsent(this.repo, state, events, at, wake, mode);
  }
  accept(command: Command, capabilities: Capabilities, at: number): CommandResult | undefined {
    const p = command.payload;
    if (p.type !== "thread.permission.set") return undefined;
    if (!this.repo.state(p.threadId))
      return { commandId: command.id, ok: false, error: "thread_not_found" };
    const error = this.set(p.threadId, p.access, capabilities, at);
    return { commandId: command.id, ok: !error, ...(error ? { error } : {}), threadId: p.threadId };
  }
}
