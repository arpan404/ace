import { LogMaxBytes, RetentionDays, StorageRetention } from "./storage.ts";
import { SourceControlPreferences } from "./source-control.ts";
import { MachineIcon } from "./host-identity.ts";
import { ProviderConfigurations } from "./provider-configuration.ts";
import { AccessMode, PermissionMode } from "./permissions.ts";
import { z } from "zod";
import { JsonValue } from "./json.ts";
import { ThreadId, WorkspaceId } from "./ids.ts";
import { ProviderKind } from "./provider.ts";
import { BrowserProfileScope } from "./browser-backend.ts";
import { UtilityModelChoice } from "./utility-model.ts";

const name = z.string().min(1).max(256);
const tier = z.enum(["default", "standard", "fast", "flex", "priority"]);
const effort = z.enum(["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const SettingsValues = z.object({
  "storage.retention": StorageRetention,
  "storage.scheduledCleanup": z.boolean(),
  /** Automatic data retention window in days. Idle threads, unused attachments and logs older than it are removed. */
  "storage.retentionDays": RetentionDays,
  /** Disk cap in bytes for each log stream, rotated segments included. */
  "logs.maxBytes": LogMaxBytes,
  "sourceControl.preferences": SourceControlPreferences,
  "providers.configuration": ProviderConfigurations,
  "host.displayName": z.string().max(256),
  "host.icon": MachineIcon,
  "projects.roots": z.array(z.string().min(1).max(4096)).max(32),
  "threads.followUpBehavior": z.enum(["steer", "queue"]),
  "threads.forkOnSwitch": z.boolean(),
  "threads.limitPolicy": z.enum(["manual", "resume_at_reset", "snooze_until_reset", "migrate_now"]),
  "providers.default": ProviderKind,
  /**
   * Roles: who `delegate` tasks with `runRole` run as. build is `coder`, judgment `planner`,
   * review `reviewer`, verify `verifier`. A role is set only when its provider is not null;
   * `default` model, tier or effort leaves that field to the provider. Global only: sessions
   * read them once when they start, into their instructions.
   */
  "providers.coder.provider": ProviderKind.nullable(),
  "providers.coder.model": name,
  "providers.coder.tier": tier,
  "providers.coder.reasoningEffort": effort,
  "providers.reviewer.provider": ProviderKind.nullable(),
  "providers.reviewer.model": name,
  "providers.reviewer.tier": tier,
  "providers.reviewer.reasoningEffort": effort,
  "providers.planner.provider": ProviderKind.nullable(),
  "providers.planner.model": name,
  "providers.planner.tier": tier,
  "providers.planner.reasoningEffort": effort,
  "providers.verifier.provider": ProviderKind.nullable(),
  "providers.verifier.model": name,
  "providers.verifier.tier": tier,
  "providers.verifier.reasoningEffort": effort,
  "browser.backend": z.enum(["auto", "embedded", "headless"]),
  "browser.backendLoss": z.enum(["pause", "headless"]),
  /** A thread's browser keeps its own cookies and storage, or opens privately in memory. */
  "browser.profile": z.enum(["persistent", "ephemeral"]),
  /**
   * Which kept profile persistent browsers open in: shared by every project (`global`, the
   * default), one per project, or one per thread. Read when a browser opens, so a change applies
   * to browsers opened afterwards. A project's own choice (`ProjectDefaults.browserProfileScope`)
   * comes before this daemon's.
   */
  "browser.profileScope": BrowserProfileScope,
  /**
   * Where ace's own Chrome on this daemon's machine saves downloads: an existing, writable
   * folder there, global only. Empty uses `browser.downloadDefault`. The desktop app's own
   * browser has its own setting; the person's Chrome decides for itself.
   */
  "browser.downloadDir": z.string().max(4096),
  /**
   * Read-only, reported by the daemon: its machine's Downloads folder (macOS and Windows
   * `~/Downloads`, Linux `XDG_DOWNLOAD_DIR`) when it exists and can be written. Empty when it
   * can't: then downloads without a chosen folder stay with each thread's browser data.
   */
  "browser.downloadDefault": z.string().max(4096),
  /**
   * Use my Chrome: agents' `evaluate` may read the page's cookies and web storage. Off by
   * default: evaluate runs where those APIs are removed (ADR 0084, amended).
   */
  "browser.userChrome.storageReads": z.boolean(),
  /**
   * Apps agents may not use with computer use, beyond ace's own list (password managers,
   * terminals, ace itself): bundle ids or app names, matched without regard to case. Global.
   */
  "computer.blockedApps": z.array(z.string().min(1).max(200)).max(200),
  /**
   * Android emulators ace starts open their own window too, for its extended controls
   * (sensors, camera, fingerprint). Off by default: ace shows and drives the device itself.
   * Read when an emulator boots, so a change applies to the next boot. Emulators the person
   * started themselves are never changed.
   */
  "devices.emulatorWindow": z.boolean(),
  /**
   * This daemon's access for new threads: the mode the person last chose or set in Settings.
   * A thread's own choice and its project's default come first.
   */
  "access.defaultMode": AccessMode,
  /** Advanced: a native mode a provider runs instead of ace's modes; its threads show Custom. */
  "access.nativeModes": z.partialRecord(ProviderKind, PermissionMode),
  "threads.useWorktree": z.boolean(),
  /**
   * How long read-only Git work before `git worktree add` may take, in milliseconds.
   * 10 minutes by default; `ACE_WORKTREE_PREPARATION_TIMEOUT_MS` overrides it.
   */
  "worktree.preparationTimeoutMs": z.number().int().min(60_000).max(3_600_000),
  "threads.autoSettleAfter": z.enum(["1d", "2d", "1w", "never"]),
  "threads.unresponsiveAfter": z.enum(["2m", "5m", "15m"]),
  "threads.settleOnMerge": z.boolean(),
  "threads.settleOnClose": z.boolean(),
  /**
   * How the Home list orders threads below Pinned: by live activity (requests and working
   * threads first, then most recent), newest created first, or by hand (`thread.place`).
   */
  "threads.sortBy": z.enum(["activity", "created", "manual"]),
  "remote.enabled": z.boolean(),
  "remote.transport": z.enum(["local", "lan", "tailscale", "relay"]),
  /** Whether agents on other paired machines may use this one, and how far (ADR 0078). */
  "remote.agentAccess": z.enum(["off", "read", "operate"]),
  /**
   * Whether pairing links open ace's hosted web app (https://app.acehq.dev) instead of the web
   * app this daemon serves over LAN or Tailscale. Off by default: the daemon's own web app always
   * matches its version; the hosted one may not.
   */
  "remote.hostedPairingLink": z.boolean(),
  "remote.relayUrl": z
    .string()
    .max(2048)
    .refine((value) => {
      if (!value) return true;
      try {
        const url = new URL(value);
        return (
          ["wss:", "ws:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (url.protocol === "wss:" || url.hostname === "127.0.0.1")
        );
      } catch {
        return false;
      }
    }, "Use a secure relay address without credentials")
    .meta({
      "x-ace-constraint":
        "Empty, or a credential-free WSS relay URL without query or fragment. WS is allowed only on 127.0.0.1.",
      examples: ["", "wss://relay.example.invalid/"],
    }),
  "automations.enabled": z.boolean(),
  /** Titles and commit/PR drafts; null picks one from the ready providers. */
  "generation.model": UtilityModelChoice.nullable(),
  /** The Commit dialog drafts its message as it opens. */
  "generation.autoDraftCommits": z.boolean(),
  "clients.theme": JsonValue,
  "clients.keybindings": JsonValue,
});
export type SettingsValues = z.infer<typeof SettingsValues>;
export const SettingsKey = SettingsValues.keyof();
export type SettingsKey = z.infer<typeof SettingsKey>;
export const SettingsDocument = z
  .object({
    version: z.literal(2),
    settings: SettingsValues.partial().catchall(JsonValue),
  })
  .catchall(JsonValue);
export type SettingsDocument = z.infer<typeof SettingsDocument>;
export const SettingsScope = z.object({
  workspaceId: WorkspaceId.optional(),
  threadId: ThreadId.optional(),
});
export type SettingsScope = z.infer<typeof SettingsScope>;
export const SettingsLayer = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("workspace"), workspaceId: WorkspaceId }),
  z.object({ kind: z.literal("thread"), threadId: ThreadId }),
]);
export type SettingsLayer = z.infer<typeof SettingsLayer>;
export const SettingsLayerKind = z.enum(["defaults", "global", "workspace", "thread"]);
export type SettingsLayerKind = z.infer<typeof SettingsLayerKind>;
/** `environment`: a host environment variable overrides every saved layer for this key. */
export const SettingsProvenance = z.enum([...SettingsLayerKind.options, "environment"]);
export type SettingsProvenance = z.infer<typeof SettingsProvenance>;
export const SettingsEntry = z.object({
  key: SettingsKey,
  value: JsonValue,
  provenance: SettingsProvenance,
  /** The value stored on the requested layer, before inheritance. */
  localValue: JsonValue.optional(),
});
export type SettingsEntry = z.infer<typeof SettingsEntry>;
export const SettingsDiagnostic = z.object({
  layer: SettingsLayerKind,
  code: z.enum(["parse", "validation", "version", "secret", "size", "io", "limit"]),
  message: z.string().max(512),
  offset: z.number().int().nonnegative().optional(),
});
export type SettingsDiagnostic = z.infer<typeof SettingsDiagnostic>;
const requestId = z.string().min(1).max(128);
export const SettingsGet = z.object({
  type: z.literal("settings.get"),
  requestId,
  key: SettingsKey,
  scope: SettingsScope,
});
export const SettingsSet = z.object({
  type: z.literal("settings.set"),
  requestId,
  key: z.string().min(1).max(256),
  value: JsonValue,
  layer: SettingsLayer,
});
/** Reset global preferences atomically; host/remote preferences are local-only. */
export const SettingsReset = z.object({ type: z.literal("settings.reset"), requestId });
export const SettingsSubscribe = z.object({
  type: z.literal("settings.subscribe"),
  requestId,
  subscriptionId: z.string().min(1).max(128),
  keys: z.array(SettingsKey).min(1).max(32),
  scope: SettingsScope,
});
export const SettingsUnsubscribe = z.object({
  type: z.literal("settings.unsubscribe"),
  requestId,
  subscriptionId: z.string().min(1).max(128),
});
export const SettingsRequest = z.discriminatedUnion("type", [
  SettingsGet,
  SettingsSet,
  SettingsReset,
  SettingsSubscribe,
  SettingsUnsubscribe,
]);
export type SettingsRequest = z.infer<typeof SettingsRequest>;
export const SettingsResult = z.object({
  type: z.literal("settings.result"),
  requestId,
  ok: z.boolean(),
  entries: z.array(SettingsEntry).max(32),
  diagnostics: z.array(SettingsDiagnostic).max(3),
});
export const SettingsChanged = z.object({
  type: z.literal("settings.changed"),
  subscriptionId: z.string(),
  entries: z.array(SettingsEntry).max(32),
});
export const SettingsDiagnosticMessage = z.object({
  type: z.literal("settings.diagnostic"),
  subscriptionId: z.string(),
  diagnostic: SettingsDiagnostic,
});
