import { z } from "zod";
import type { AccessMode, AccessModeOffer, PermissionMode, ProviderKind } from "@ace/protocol";

/**
 * ace's four access modes and their exact native settings per provider (ADR 0075).
 * A provider offers a mode only when it supports it natively; ace never emulates one with
 * gates or a reviewer of its own. Pure: no I/O, safe for daemon and clients alike.
 */
export const accessModeOrder = ["read-only", "ask", "auto-review", "full-access"] as const;

/** 0 reads and plans, 1 asks before changes, 2 edits with risky actions reviewed, 3 unrestricted. */
export function accessRank(mode: AccessMode): number {
  return accessModeOrder.indexOf(mode);
}

export const CodexAccessOptions = z.strictObject({
  permissions: z.string().min(1).max(256),
  approvalPolicy: z.enum(["untrusted", "on-request", "never"]).optional(),
  approvalsReviewer: z.enum(["user", "auto_review", "guardian_subagent"]),
});
const codex = (
  permissions: string,
  approvalPolicy: "on-request" | "never",
  approvalsReviewer: "user" | "auto_review",
) => JSON.stringify({ permissions, approvalPolicy, approvalsReviewer });
export const cursorMode = (enabled: boolean, autoReview: boolean) =>
  JSON.stringify({ sandboxOptions: { enabled }, autoReview });

/** Pi's own read-only tool allowlist (`pi --tools read,grep,find,ls`). */
export const piReadOnlyTools = ["read", "grep", "find", "ls"] as const;
export const piNative = { readOnly: "tools:read,grep,find,ls", unrestricted: "unrestricted" };
/** OpenCode selectors: the agent, plus the session rules ace writes (never the repo's config). */
export const opencodeNative = {
  readOnly: "plan+ace",
  ask: "build+ask",
  fullAccess: "build+allow",
};

type Natives = Partial<Record<AccessMode, PermissionMode>>;
const providerNatives: Partial<Record<ProviderKind, Natives>> = {
  claude: {
    "read-only": "plan",
    ask: "default",
    "auto-review": "auto",
    "full-access": "bypassPermissions",
  },
  codex: {
    "read-only": codex(":read-only", "never", "user"),
    ask: codex(":read-only", "on-request", "user"),
    "auto-review": codex(":workspace", "on-request", "auto_review"),
    "full-access": codex(":danger-full-access", "never", "user"),
  },
  // No native reviewer: Auto review is not offered.
  opencode: {
    "read-only": opencodeNative.readOnly,
    ask: opencodeNative.ask,
    "full-access": opencodeNative.fullAccess,
  },
  // The SDK has no human-approval path and its sandbox still writes the workspace.
  cursor: { "auto-review": cursorMode(true, true), "full-access": cursorMode(false, false) },
  // Pi has no approval channel: a native read-only tool allowlist, or its unrestricted default.
  pi: { "read-only": piNative.readOnly, "full-access": piNative.unrestricted },
};

/** Source-verified ACP agent profiles; an unprofiled agent's modes can't be ranked. */
const acpProfiles: Record<string, Natives> = {
  "gemini-043": { "read-only": "plan", ask: "default", "full-access": "yolo" },
  "qwen-modern": { "read-only": "plan", ask: "default", "full-access": "yolo" },
  "claude-bridge": {
    "read-only": "plan",
    ask: "default",
    "auto-review": "auto",
    "full-access": "bypassPermissions",
  },
  "codex-bridge": {
    "read-only": "read-only",
    "auto-review": "agent",
    "full-access": "agent-full-access",
  },
};
const antigravity: Natives = { "full-access": "yolo" };

export interface AccessIdentity {
  provider: ProviderKind;
  /** The ACP agent profile, when one is verified. */
  profile?: string | undefined;
}

function natives(identity: AccessIdentity): Natives {
  if (identity.provider === "antigravity") return antigravity;
  if (identity.provider === "acp")
    return identity.profile ? (acpProfiles[identity.profile] ?? {}) : {};
  return providerNatives[identity.provider] ?? {};
}

/**
 * The modes an instance offers, least capable first. `available` narrows the table to native
 * selectors the live instance reports (Codex permission profiles, ACP session modes).
 */
export function accessModeOffers(
  identity: AccessIdentity,
  available?: (native: PermissionMode) => boolean,
): AccessModeOffer[] {
  const table = natives(identity);
  return accessModeOrder.flatMap((mode) => {
    const native = table[mode];
    return native !== undefined && (!available || available(native)) ? [{ mode, native }] : [];
  });
}

/** Codex offers a mode when the CLI allows the built-in permission profile it runs on. */
export function codexAccessAvailable(allowedProfiles: readonly string[]) {
  return (native: PermissionMode) =>
    allowedProfiles.includes(CodexAccessOptions.parse(JSON.parse(native)).permissions);
}

/**
 * What an instance offers: its reported offers, else ace's table for a first-party provider.
 * An ACP agent reports its modes only once a session opens, so it offers none until then.
 */
export function reportedOrTable(
  provider: ProviderKind,
  reported: readonly AccessModeOffer[] | undefined,
): AccessModeOffer[] {
  if (reported) return [...reported];
  return provider === "acp" ? [] : accessModeOffers({ provider });
}

/**
 * An instance's offers from the native selectors it reports: Codex by its allowed built-in
 * profiles, ACP agents by the session modes they advertise, the rest by ace's table.
 */
export function instanceAccessModes(
  identity: AccessIdentity,
  reported: readonly PermissionMode[],
): AccessModeOffer[] {
  switch (identity.provider) {
    case "codex":
      // No profile list reported yet: the built-in profiles every Codex has.
      return accessModeOffers(
        identity,
        reported.length ? codexAccessAvailable(reported) : undefined,
      );
    case "acp":
    case "antigravity":
      return accessModeOffers(identity, (native) => reported.includes(native));
    default:
      return accessModeOffers(identity);
  }
}

/**
 * The broadest offered mode no broader than `requested`: the mode itself when offered,
 * otherwise the nearest stricter one. Never looser; undefined when nothing that strict exists.
 */
export function stricterOffer(
  requested: AccessMode,
  offers: readonly AccessModeOffer[],
): AccessModeOffer | undefined {
  let best: AccessModeOffer | undefined;
  for (const offer of offers)
    if (
      accessRank(offer.mode) <= accessRank(requested) &&
      (!best || accessRank(offer.mode) > accessRank(best.mode))
    )
      best = offer;
  return best;
}

/** The ace mode a native selector runs as on this instance, if it is one of its offers. */
export function accessForNative(
  native: PermissionMode | null | undefined,
  offers: readonly AccessModeOffer[],
): AccessMode | undefined {
  return native == null ? undefined : offers.find((offer) => offer.native === native)?.mode;
}

const Cursor = z.object({
  sandboxOptions: z.object({ enabled: z.boolean() }),
  autoReview: z.boolean(),
});
const CodexStored = z.object({ permissions: z.string() }).passthrough();
const acpLegacy: Record<string, AccessMode> = {
  plan: "read-only",
  "read-only": "read-only",
  default: "ask",
  auto_edit: "auto-review",
  "auto-edit": "auto-review",
  acceptEdits: "auto-review",
  auto: "auto-review",
  agent: "auto-review",
  "workspace-write": "auto-review",
  yolo: "full-access",
  bypassPermissions: "full-access",
  "agent-full-access": "full-access",
};

/**
 * One-time load mapping of a mode stored before the four ace modes (ADR 0075 migration table).
 * Undefined means the value has no ace equivalent and the defaults apply.
 */
export function storedAccess(
  provider: ProviderKind,
  stored: string | null | undefined,
): AccessMode | undefined {
  if (stored == null) return undefined;
  if ((accessModeOrder as readonly string[]).includes(stored)) return stored as AccessMode;
  switch (provider) {
    case "claude":
      return (
        {
          plan: "read-only",
          default: "ask",
          dontAsk: "ask",
          acceptEdits: "auto-review",
          auto: "auto-review",
          bypassPermissions: "full-access",
        } as const
      )[stored];
    case "codex": {
      let permissions = stored;
      if (stored.startsWith("{")) {
        const parsed = CodexStored.safeParse(safeJson(stored));
        if (!parsed.success) return undefined;
        permissions = parsed.data.permissions;
      }
      if (permissions === ":read-only") return "read-only";
      if (permissions === ":workspace") return "auto-review";
      if (permissions === ":danger-full-access") return "full-access";
      // A custom permission profile can't be ranked; it runs no broader than Ask.
      return "ask";
    }
    case "opencode":
      return ({ plan: "read-only", build: "auto-review" } as const)[stored];
    case "cursor": {
      const parsed = Cursor.safeParse(safeJson(stored));
      if (!parsed.success) return undefined;
      return !parsed.data.sandboxOptions.enabled && !parsed.data.autoReview
        ? "full-access"
        : "auto-review";
    }
    case "pi":
      return undefined;
    case "acp":
    case "antigravity":
      return acpLegacy[stored];
  }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
