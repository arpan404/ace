import {
  SettingsKey,
  SettingsValues,
  type SettingsEntry,
  type SettingsRequest,
  type ServerMessage,
} from "@ace/protocol";
import { z } from "zod";

/** Where a connection's pushes go; the connection owns its own lifetime. */
export type Push = (message: ServerMessage) => void;

interface Subscriber {
  push: Push;
  id: string;
  keys: ReadonlySet<string>;
}

/**
 * The daemon's settings service in memory: one global layer over nothing, so unset keys have no
 * entry. Like the daemon, unknown keys and invalid values are refused, and every subscriber of a
 * changed key is told.
 */
export class FakeSettings {
  private values = new Map<string, unknown>();
  private subscribers = new Set<Subscriber>();
  constructor(initial: Readonly<Record<string, unknown>> = {}) {
    for (const [key, value] of Object.entries(initial))
      if (SettingsKey.safeParse(key).success) this.values.set(key, value);
  }
  /** The stored value, as tests check what a page wrote. */
  get(key: string): unknown {
    return this.values.get(key);
  }
  private entries(keys: readonly string[]): SettingsEntry[] {
    return keys.flatMap((key) => {
      const parsed = SettingsKey.safeParse(key);
      if (!parsed.success || !this.values.has(key)) return [];
      return [{ key: parsed.data, value: this.json(key), provenance: "global" as const }];
    });
  }
  private json(key: string): SettingsEntry["value"] {
    return z.json().parse(this.values.get(key));
  }
  handle(message: SettingsRequest, push: Push): ServerMessage {
    const reply = (ok: boolean, entries: SettingsEntry[] = []) =>
      ({
        type: "settings.result",
        requestId: message.requestId,
        ok,
        entries,
        diagnostics: ok ? [] : [{ layer: "global", code: "validation", message: "Refused" }],
      }) satisfies ServerMessage;
    switch (message.type) {
      case "settings.get":
        return reply(true, this.entries([message.key]));
      case "settings.subscribe":
        this.subscribers.add({ push, id: message.subscriptionId, keys: new Set(message.keys) });
        return reply(true, this.entries(message.keys));
      case "settings.set": {
        const key = SettingsKey.safeParse(message.key);
        if (!key.success || message.layer.kind !== "global") return reply(false);
        const value = SettingsValues.shape[key.data].safeParse(message.value);
        if (!value.success) return reply(false);
        this.values.set(key.data, value.data);
        this.notify(key.data);
        return reply(true, this.entries([key.data]));
      }
    }
  }
  private notify(key: string): void {
    const entries = this.entries([key]);
    for (const subscriber of this.subscribers)
      if (subscriber.keys.has(key))
        subscriber.push({ type: "settings.changed", subscriptionId: subscriber.id, entries });
  }
  release(push: Push): void {
    for (const subscriber of this.subscribers)
      if (subscriber.push === push) this.subscribers.delete(subscriber);
  }
}
