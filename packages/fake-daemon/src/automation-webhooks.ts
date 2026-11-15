import type { AutomationWebhookState, AutomationWebhookVia, SettingsKey } from "@ace/protocol";
import { sha256Hex } from "./sha256.ts";

/** Where the fake machine's webhooks are reached on each way in (ADR 0158, decision 3). */
const bases = {
  tailscale: "https://fake-mac.tail0fake.ts.net",
  relay: "https://cloud.acehq.dev/m/fake-host",
} as const;
const switches = {
  custom: "remote.publicUrlWebhooks",
  tailscale: "remote.tailscaleWebhooks",
  relay: "remote.relayWebhooks",
} as const satisfies Record<AutomationWebhookVia, string>;
const problem =
  "Turn on a way in for automation webhooks in Settings: your own URL, Tailscale or ace cloud.";
const encoder = new TextEncoder();

const digest = (text: string) => sha256Hex(encoder.encode(text));

/** 32 bytes as `whsec_` plus base64, the shape the daemon generates. */
function secretFrom(hex: string): string {
  const bytes = hex.match(/../g)?.map((pair) => String.fromCharCode(Number.parseInt(pair, 16)));
  return `whsec_${btoa(bytes?.join("") ?? "")}`;
}

/**
 * Webhook secrets and hook ids, as the daemon keeps them beside its automations. Everything is
 * derived from the automation's id and how often it was rotated, so tests and dev mode see the
 * same secret each run. The secret leaves only in the rotate reply.
 */
export class FakeAutomationWebhooks {
  private hooks = new Map<string, string>();
  /** Kept through a revoke, so a secret made again never repeats a revoked one. */
  private rotations = new Map<string, number>();
  private setting: (key: SettingsKey) => unknown;
  /** Reads the fake machine's settings: the three switches and `remote.mcpPublicUrl`. */
  constructor(setting: (key: SettingsKey) => unknown) {
    this.setting = setting;
  }
  /** Each way that is on, those ace cloud doesn't carry first, as the daemon orders them. */
  private bases(): { via: AutomationWebhookVia; base: string }[] {
    const own = this.setting("remote.mcpPublicUrl");
    const custom = typeof own === "string" && own ? new URL(own).origin : undefined;
    const all = { custom, ...bases };
    return (["custom", "tailscale", "relay"] as const).flatMap((via) => {
      const base = all[via];
      return this.setting(switches[via]) === true && base ? [{ via, base }] : [];
    });
  }
  /** What a list shows for one webhook automation. */
  state(automationId: string): AutomationWebhookState {
    const hookId = this.hooks.get(automationId);
    if (!hookId) return { active: false, path: null, url: null, urls: [] };
    const path = `/hooks/${hookId}`;
    const urls = this.bases().map(({ via, base }) => ({ via, url: `${base}${path}` }));
    const first = urls[0];
    return first
      ? { active: true, path, url: first.url, urls }
      : { active: true, path, url: null, urls, problem };
  }
  /** A new secret; the hook id is made the first time and kept across rotations. */
  rotate(automationId: string): { webhook: AutomationWebhookState; secret: string } {
    const rotations = (this.rotations.get(automationId) ?? 0) + 1;
    this.rotations.set(automationId, rotations);
    if (!this.hooks.has(automationId))
      this.hooks.set(automationId, digest(`hook:${automationId}:${rotations}`).slice(0, 32));
    const secret = secretFrom(digest(`secret:${automationId}:${rotations}`));
    return { webhook: this.state(automationId), secret };
  }
  /** Deletes the secret with its hook id, so the URL stops answering. */
  revoke(automationId: string): AutomationWebhookState {
    this.hooks.delete(automationId);
    return this.state(automationId);
  }
}
