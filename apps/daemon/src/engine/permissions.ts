import { nearestOffer, reportedOrTable } from "@ace/provider-kit/access-modes";
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
  type ProviderKind,
} from "@ace/protocol";
import { supportsPermissionMode } from "@ace/core";
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
  permissionState,
} from "./permission-storage.ts";

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
  /** The ace mode asked for (the thread's own or the default), when one was resolved. */
  wanted?: AccessMode;
  /** The thread's choice revision this was resolved from (see `Permissions.revision`). */
  revision: number;
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
  /** Bumped by each accepted choice, so an acknowledgement can tell it is about an older one. */
  private revisions = new Map<ThreadId, number>();
  constructor(repo: EngineRepository) {
    this.repo = repo;
    createPermissionTables(repo);
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
  /**
   * A host thread's mode (ADR 0121): no launch ever resolves it, so the mode is its own effective
   * mode at once and the ceiling of its children from then on. Returns whether it changed.
   */
  hold(id: ThreadId, access: AccessMode, at: number): boolean {
    this.ensure(id);
    const before = this.read(id);
    if (before.override === access && before.effective === access) return false;
    this.repo.store.atomic((db) =>
      db
        .prepare("UPDATE engine_permissions SET override=?, effective=? WHERE thread_id=?")
        .run(access, access, id),
    );
    this.repo.store.appendEvents(id, [{ type: "thread.updated", permission: this.state(id) }], at);
    return true;
  }
  effective(id: ThreadId): AccessSelection | null {
    return this.read(id).effective;
  }
  /** The revision of the thread's own choice: it changes whenever a new choice is accepted. */
  revision(id: ThreadId): number {
    return this.revisions.get(id) ?? 0;
  }
  /** Whether `selection` is no broader than what this thread's ancestry allows now. */
  within(id: ThreadId, selection: AccessSelection | null): boolean {
    const provider = this.repo.requireState(id).config.provider;
    try {
      return this.contained(id, provider, selection, this.offers(id)) === selection;
    } catch {
      return false;
    }
  }
  /** Every thread whose access is contained by `id`'s, nearest first (bounded like ancestry). */
  descendants(id: ThreadId): ThreadId[] {
    const found: ThreadId[] = [];
    const seen = new Set<string>([id]);
    let level: string[] = [id];
    for (let depth = 0; level.length && depth < 64; depth++) {
      const next: string[] = [];
      for (const parent of level) {
        const rows = this.repo.store.atomic((db) =>
          db.prepare("SELECT thread_id FROM engine_permissions WHERE parent=?").all(parent),
        );
        for (const row of rows) {
          const child = importThreadId.safeParse((row as { thread_id?: unknown }).thread_id);
          if (!child.success || seen.has(child.data)) continue;
          seen.add(child.data);
          found.push(child.data);
          next.push(child.data);
        }
      }
      level = next;
    }
    return found;
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
    this.revisions.set(id, this.revision(id) + 1);
    this.repo.store.appendEvents(
      id,
      [{ type: "thread.updated", permission: { ...this.state(id), pending: true } }],
      at,
    );
    return undefined;
  }
  /**
   * What the thread runs next: an Advanced native override, else its own mode, else the
   * project's and daemon's default, as the nearest mode the provider offers (stricter first,
   * else looser), then contained by its ancestry. A provider with no ace modes runs its default.
   */
  async resolve(
    id: ThreadId,
    settings?: PermissionSettings,
    nativeCapabilities?: Capabilities,
  ): Promise<ResolvedAccess> {
    const provider = this.repo.requireState(id).config.provider;
    const defaults = (await settings?.(id)) ?? { access: "auto-review" as const };
    // Read after the await: a choice accepted while the settings loaded is the one resolved.
    const revision = this.revision(id);
    const thread = this.repo.store.getThread(id);
    const capabilities =
      nativeCapabilities ?? thread?.effectiveCapabilities ?? thread?.capabilities;
    const offers = offersOf(provider, capabilities);
    // A Spade bot's session (ADR 0133) runs read-only or not at all: no native mode the person
    // chose for the provider, no provider default, no override.
    if (thread?.host === "spade-bot") {
      const readOnly = offers.find((offer) => offer.mode === "read-only");
      if (!readOnly)
        throw new AccessError(
          "access_mode_unavailable",
          `${provider} offers no read-only mode, which a Spade bot's session needs`,
        );
      const selection = this.contained(id, provider, readOnly.mode, offers);
      if (selection !== "read-only")
        throw new AccessError("access_mode_unavailable", "a Spade bot's session must be read-only");
      return { selection, native: readOnly.native, revision };
    }
    let selection: AccessSelection | null;
    let wanted: AccessMode | undefined;
    if (defaults.custom && supportsPermissionMode(capabilities, defaults.custom))
      selection = customSelection(defaults.custom);
    else if (!offers.length) selection = null;
    else {
      const requested = AccessMode.safeParse(this.read(id).override);
      wanted = requested.success ? requested.data : defaults.access;
      const offer = nearestOffer(wanted, offers);
      if (!offer)
        throw new AccessError("access_mode_unavailable", `${provider} offers no access mode`);
      selection = offer.mode;
    }
    selection = this.contained(id, provider, selection, offers);
    return {
      selection,
      native: nativeFor(selection, offers),
      revision,
      ...(wanted ? { wanted } : {}),
    };
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
  /**
   * What the live session reports running, recorded exactly, even when its ancestry no longer
   * allows it: the caller brings it back within, and until then the thread doesn't claim less.
   */
  observed(id: ThreadId, selection: AccessSelection | null, at: number): void {
    this.ensure(id);
    this.repo.store.atomic(() => {
      this.repo.store.atomic((db) =>
        db
          .prepare("UPDATE engine_permissions SET effective=? WHERE thread_id=?")
          .run(selection, id),
      );
      this.repo.store.appendEvents(
        id,
        [{ type: "thread.updated", permission: this.state(id) }],
        at,
      );
    });
  }
  /**
   * The agent switched its own mode, within what its ancestry allows: that is now the thread's
   * mode, its choice included, so it neither reads as pending nor reverts at the next open.
   */
  adopted(id: ThreadId, selection: AccessSelection | null, at: number): void {
    const mode = AccessMode.safeParse(selection);
    this.ensure(id);
    this.repo.store.atomic(() => {
      this.repo.store.atomic((db) =>
        db
          .prepare("UPDATE engine_permissions SET override=?, effective=? WHERE thread_id=?")
          .run(mode.success ? mode.data : null, selection, id),
      );
      this.revisions.set(id, this.revision(id) + 1);
      this.repo.store.appendEvents(
        id,
        [{ type: "thread.updated", permission: this.state(id) }],
        at,
      );
    });
  }
  /**
   * The thread's own choice when the session it just opened runs something else, because the
   * instance doesn't offer that mode. The choice is replaced by what runs, so it never reads as
   * pending forever; the caller tells the person. Undefined when the choice runs as asked, or
   * when a Custom native from settings is what runs instead, or when the choice changed since
   * `revision` (the newer one is still on its way and is never rewritten).
   */
  unhonoured(
    id: ThreadId,
    running: AccessSelection | null,
    at: number,
    revision: number,
  ): AccessMode | undefined {
    if (revision !== this.revision(id)) return undefined;
    const requested = AccessMode.safeParse(this.read(id).override);
    if (!requested.success || requested.data === running || customNative(running)) return undefined;
    const kept = AccessMode.safeParse(running);
    this.repo.store.atomic(() => {
      this.repo.store.atomic((db) =>
        db
          .prepare("UPDATE engine_permissions SET override=? WHERE thread_id=?")
          .run(kept.success ? kept.data : null, id),
      );
      this.repo.store.appendEvents(
        id,
        [{ type: "thread.updated", permission: this.state(id) }],
        at,
      );
    });
    return requested.data;
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
  /**
   * A native mode asked for by name (`thread.mode.set`) is the ace mode the instance maps it to,
   * checked and applied exactly like `thread.permission.set`. A native mode ace has no mode for
   * can't be ranked against a parent or tracked, so it is refused; Advanced settings set those.
   */
  acceptNative(
    command: Command,
    capabilities: Capabilities,
    at: number,
  ): CommandResult | undefined {
    const p = command.payload;
    if (p.type !== "thread.mode.set") return undefined;
    const state = this.repo.state(p.threadId);
    if (!state) return { commandId: command.id, ok: false, error: "thread_not_found" };
    const offer = offersOf(state.config.provider, capabilities).find(
      (entry) => entry.native === p.mode,
    );
    const error = offer
      ? this.set(p.threadId, offer.mode, capabilities, at)
      : "permission_mode_unsupported";
    return { commandId: command.id, ok: !error, ...(error ? { error } : {}), threadId: p.threadId };
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
