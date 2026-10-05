import {
  SettingsKey,
  SettingsValues,
  type SettingsEntry,
  type SettingsRequest,
  type SettingsScope,
  type ServerMessage,
} from "@ace/protocol";
import { defaults } from "@ace/settings/defaults";
import { legacyPermissionMode } from "@ace/settings/legacy-permissions";
import { z } from "zod";

/** Where a connection's pushes go; the connection owns its own lifetime. */
export type Push = (message: ServerMessage) => void;

interface Subscriber {
  push: Push;
  id: string;
  keys: ReadonlySet<string>;
  scope: SettingsScope;
}

const subscriberLimit = 64;
const layerLimit = 256;
const organizationKeys = [
  "threads.autoSettleAfter",
  "threads.settleOnMerge",
  "threads.settleOnClose",
] as const;

/**
 * The daemon's settings service in memory: thread over workspace over global over the shipped
 * defaults, each entry reporting the layer it came from. Like the daemon, unknown keys and
 * invalid values are refused, and every subscriber of a changed key is told, until it
 * unsubscribes or its connection goes away.
 */
export class FakeSettings {
  private global = new Map<string, unknown>();
  private layers = new Map<string, Map<string, unknown>>();
  private subscribers = new Set<Subscriber>();
  private workspaceOf: (threadId: string) => string | undefined;
  constructor(
    initial: Readonly<Record<string, unknown>> = {},
    workspaceOf: (threadId: string) => string | undefined = () => undefined,
  ) {
    this.workspaceOf = workspaceOf;
    this.seed(initial);
  }
  /** Global values as a long-running daemon holds them; unknown keys are ignored. */
  seed(values: Readonly<Record<string, unknown>>): void {
    for (const [key, value] of Object.entries(values))
      if (SettingsKey.safeParse(key).success) this.global.set(key, value);
    if (!this.global.has("permissions.defaultMode") && this.global.has("approvals.policy")) {
      const policy = this.global.get("approvals.policy");
      this.global.set("permissions.defaultMode", legacyPermissionMode(policy));
    }
  }
  /** Drop a global value, as a settings file that never held it; the default applies again. */
  unset(key: string): void {
    if (this.global.delete(key)) this.notify(key);
  }
  /** The effective global value, as tests check what a page wrote. */
  get(key: string): unknown {
    return this.global.has(key) ? this.global.get(key) : Reflect.get(defaults, key);
  }
  /** One setting resolved for a scope (thread over workspace over global over defaults). */
  resolve(key: string, scope: SettingsScope): unknown {
    return this.entries([key], scope)[0]?.value;
  }
  /** The thread-settle settings the organization projection reads for this scope. */
  organizationEntries(scope: SettingsScope): SettingsEntry[] {
    return organizationKeys.flatMap((key) => this.entries([key], scope));
  }
  /** One entry per known key, resolved through the layers this scope reaches. */
  private entries(keys: readonly string[], scope: SettingsScope = {}): SettingsEntry[] {
    const thread = scope.threadId ? this.layers.get(`thread:${scope.threadId}`) : undefined;
    const workspaceId =
      scope.workspaceId ?? (scope.threadId ? this.workspaceOf(scope.threadId) : undefined);
    const workspace = workspaceId ? this.layers.get(`workspace:${workspaceId}`) : undefined;
    return keys.flatMap((key) => {
      const parsed = SettingsKey.safeParse(key);
      if (!parsed.success) return [];
      const [provenance, value] = thread?.has(key)
        ? (["thread", thread.get(key)] as const)
        : workspace?.has(key)
          ? (["workspace", workspace.get(key)] as const)
          : this.global.has(key)
            ? (["global", this.global.get(key)] as const)
            : (["defaults", Reflect.get(defaults, key)] as const);
      return [{ key: parsed.data, value: z.json().parse(value ?? null), provenance }];
    });
  }
  handle(message: SettingsRequest, push: Push): ServerMessage {
    const reply = (ok: boolean, entries: SettingsEntry[] = [], refusal = "Refused") =>
      ({
        type: "settings.result",
        requestId: message.requestId,
        ok,
        entries,
        diagnostics: ok ? [] : [{ layer: "global", code: "validation", message: refusal }],
      }) satisfies ServerMessage;
    switch (message.type) {
      case "settings.get":
        return reply(true, this.entries([message.key], message.scope));
      case "settings.subscribe": {
        const existing = [...this.subscribers].find(
          (subscriber) => subscriber.push === push && subscriber.id === message.subscriptionId,
        );
        if (existing) this.subscribers.delete(existing);
        if (this.subscribers.size >= subscriberLimit)
          return {
            ...reply(false),
            diagnostics: [{ layer: "global", code: "limit", message: "Subscription limit" }],
          };
        this.subscribers.add({
          push,
          id: message.subscriptionId,
          keys: new Set(message.keys),
          scope: message.scope,
        });
        return reply(true, this.entries(message.keys, message.scope));
      }
      case "settings.unsubscribe":
        for (const subscriber of this.subscribers)
          if (subscriber.push === push && subscriber.id === message.subscriptionId)
            this.subscribers.delete(subscriber);
        return reply(true);
      case "settings.set": {
        const key = SettingsKey.safeParse(message.key);
        if (!key.success) return reply(false, [], "Unknown setting");
        const value = SettingsValues.shape[key.data].safeParse(message.value);
        if (!value.success) return reply(false, [], "Invalid setting value");
        const layer = message.layer;
        const id =
          layer.kind === "global"
            ? undefined
            : layer.kind === "thread"
              ? `thread:${layer.threadId}`
              : `workspace:${layer.workspaceId}`;
        if (key.data === "browser.allowedOrigins" && layer.kind !== "global")
          return {
            ...reply(false),
            diagnostics: [
              {
                layer: layer.kind,
                code: "validation",
                message: "Browser allowlist is a global user setting",
              },
            ],
          };
        let values = id === undefined ? this.global : this.layers.get(id);
        if (!values) {
          if (this.layers.size >= layerLimit)
            return {
              ...reply(false),
              diagnostics: [{ layer: layer.kind, code: "limit", message: "Settings layer limit" }],
            };
          values = new Map();
          this.layers.set(id ?? "", values);
        }
        values.set(key.data, value.data);
        if (key.data === "approvals.policy") {
          values.set("permissions.defaultMode", legacyPermissionMode(value.data));
          this.notify("permissions.defaultMode");
        }
        this.notify(key.data);
        const scope: SettingsScope =
          layer.kind === "thread"
            ? { threadId: layer.threadId }
            : layer.kind === "workspace"
              ? { workspaceId: layer.workspaceId }
              : {};
        return reply(true, this.entries([key.data], scope));
      }
    }
  }
  private notify(key: string): void {
    for (const subscriber of this.subscribers)
      if (subscriber.keys.has(key))
        subscriber.push({
          type: "settings.changed",
          subscriptionId: subscriber.id,
          entries: this.entries([key], subscriber.scope),
        });
  }
  release(push: Push): void {
    for (const subscriber of this.subscribers)
      if (subscriber.push === push) this.subscribers.delete(subscriber);
  }
}
