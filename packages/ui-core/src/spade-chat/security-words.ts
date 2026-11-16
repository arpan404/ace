import type {
  SpadeEgressEntry,
  SpadeGrant,
  SpadeNetworkMode,
  SpadeSecurityMachine,
} from "./security.ts";

/* What Spade's security settings say, in words (ADR 0167, spade/docs/security.md). Pure. */

export const spadeNetworkModes: readonly { value: SpadeNetworkMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "allow_list", label: "Listed sites" },
  { value: "open", label: "Open" },
];

/** The machine's sandbox in one sentence. */
export function spadeSandboxSentence(machine: SpadeSecurityMachine): string {
  const place = machine.platform === "macos" ? "this Mac" : "this computer";
  if (machine.contained) return `Commands run sealed off on ${place}.`;
  const computer = machine.platform === "macos" ? "This Mac" : "This computer";
  return `${computer} can't seal commands off yet, so Spade asks before they run.`;
}

/** A grant as a sentence: "Push to `spade/*` of arpan404/ace". */
export function spadeGrantSentence(grant: SpadeGrant): string {
  switch (grant.kind) {
    case "folder":
      return grant.write ? `Read and write ${grant.path}` : `Read ${grant.path}`;
    case "tool": {
      const limits = Object.entries(grant.arguments).map(([key, pattern]) => `${key} ${pattern}`);
      return limits.length
        ? `Use ${grant.tool} with ${limits.join(", ")}`
        : `Use ${grant.tool} without asking`;
    }
    case "git_push":
      return `Push to ${grant.branch} of ${grant.repo}`;
    case "pr_comment":
      return grant.ownOnly
        ? `Comment on its own pull requests in ${grant.repo}`
        : `Comment on pull requests in ${grant.repo}`;
    case "other":
      return grant.name ? `Allowed: ${grant.name}` : "Allowed";
  }
}

/** The host of an allow entry, without `*.`, a port or IPv6 brackets. */
function hostOf(entry: string): string {
  const lower = entry.trim().toLowerCase().replace(/^\*\./, "");
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(lower);
  if (bracketed) return bracketed[1] ?? "";
  // One colon is a port; more is a bare IPv6 address.
  return lower.split(":").length === 2 ? (lower.split(":")[0] ?? "") : lower;
}

/**
 * Whether an allow entry names a place on a private network: loopback, `localhost`, `.local`,
 * private, link-local or CGNAT IPv4, IPv6 loopback, link-local or unique-local. Spade refuses
 * these unless listed literally, so they are listed apart.
 */
export function spadePrivateHost(entry: string): boolean {
  const host = hostOf(entry);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (!host.includes(":")) return false;
  return host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
}

/** One connection in the network activity: its last line, its bytes so far. */
export interface SpadeEgressRow {
  key: string;
  /** `host`, with its port when it isn't 443 or 80. */
  host: string;
  at: number;
  sent: number;
  received: number;
  /** Why it was refused or failed; undefined when it went through. */
  refused: string | undefined;
}

/**
 * The egress log as rows, newest first: a connection's lines folded into one, holding its
 * latest bytes and time. Lines without a connection number stand alone.
 */
export function spadeEgressRows(entries: readonly SpadeEgressEntry[]): SpadeEgressRow[] {
  const rows = new Map<string, SpadeEgressRow>();
  entries.forEach((entry, at) => {
    const key = entry.connection > 0 ? `c${entry.connection}` : `l${at}`;
    const failed = !entry.allowed || entry.phase === "refused" || entry.phase === "failed";
    rows.delete(key);
    rows.set(key, {
      key,
      host: entry.port === 443 || entry.port === 80 ? entry.host : `${entry.host}:${entry.port}`,
      at: entry.at,
      sent: entry.sent,
      received: entry.received,
      refused: failed ? (entry.reason ?? (entry.allowed ? "Failed" : "Refused")) : undefined,
    });
  });
  return [...rows.values()].toSorted((a, b) => b.at - a.at);
}
