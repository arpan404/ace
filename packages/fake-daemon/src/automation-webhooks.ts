import type { AutomationWebhookState } from "@ace/protocol";
import { sha256Hex } from "./sha256.ts";

/** Where the fake machine's webhooks would be reached: ace cloud's forwarded path (ADR 0158). */
const base = "https://cloud.acehq.dev/m/fake-host";
const problem = "Turn on Automation webhooks through ace cloud in Settings.";
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
  private relayed: () => boolean;
  constructor(relayed: () => boolean) {
    this.relayed = relayed;
  }
  /** What a list shows for one webhook automation. */
  state(automationId: string): AutomationWebhookState {
    const hookId = this.hooks.get(automationId);
    if (!hookId) return { active: false, path: null, url: null };
    const path = `/hooks/${hookId}`;
    if (!this.relayed()) return { active: true, path, url: null, problem };
    return { active: true, path, url: `${base}${path}` };
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
