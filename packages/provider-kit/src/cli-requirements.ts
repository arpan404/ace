import { checkCliVersion, type CliVersionCheck } from "./cli-versions.ts";

/*
 * Every provider CLI and ACP agent ace launches, and the oldest version of each that ace
 * supports. This is the one owner of those minimums: adapters, discovery, the installer, the
 * model catalog and the UI read them from here. The evidence behind each floor is tabulated in
 * docs/research/providers/minimum-versions.md. Pure and portable (no Node built-ins).
 */

export interface CliRequirement {
  /** The product as people know it: "Claude Code", "Gemini CLI". */
  name: string;
  /** The oldest version ace supports. */
  minimum: string;
  /** What ace depends on that this version is the first (or oldest verified) to provide. */
  reason: string;
  /**
   * Backed by a recorded fixture, an inspected release or a generated schema. False when the
   * floor is only the oldest version a reviewed profile names.
   */
  verified: boolean;
}

export const cliRequirements = {
  // Provider CLIs (ADR 0002): reached only through the user's own installation.
  claude: {
    name: "Claude Code",
    minimum: "2.1.286",
    reason:
      "Recorded tree contract (fixtures/claude/2.1.286); reply frames carry user_message_uuids, which bind steers to the turn that consumed them; native steering (priority now, SDK 0.3.286).",
    verified: true,
  },
  codex: {
    name: "Codex",
    minimum: "0.159.1",
    reason:
      "The app-server protocol ace is generated from (adapter-codex/src/generated/VERSION): clientUserMessageId on turn/start, turn/steer and thread/queue/add.",
    verified: true,
  },
  opencode: {
    name: "OpenCode",
    minimum: "2.0.22",
    reason:
      "The v2 HTTP API of @opencode/client 2.0.22, including session.inbox.delivered events (fixtures/opencode/2.0.22). Newer lines are checked against the served OpenAPI document instead.",
    verified: true,
  },
  pi: {
    name: "Pi",
    minimum: "0.85.1",
    reason:
      "The first audited RPC release (ADR 0050): get_commands, auth check --json and the SDK ModelRuntime.",
    verified: true,
  },
  "cursor-sdk": {
    name: "Cursor SDK",
    minimum: "1.0.35",
    reason:
      "Ships with ace (ADR 0043) and is pinned exactly; a different version means a broken ace installation.",
    verified: true,
  },
  // ACP agents (ADR 0044).
  antigravity: {
    name: "Antigravity",
    minimum: "1.2.1",
    reason:
      "The inspected agy_acp_server release: loadSession, sessionCapabilities.resume and image prompts.",
    verified: true,
  },
  gemini: {
    name: "Gemini CLI",
    minimum: "0.43.0",
    reason:
      "Reviewed profile gemini-043, whose initialize reply was inspected: --acp and the legacy model selector.",
    verified: true,
  },
  "qwen-code": {
    name: "Qwen Code",
    minimum: "0.0.14",
    reason: "Reviewed profile qwen-old, inspected locally: --experimental-acp.",
    verified: true,
  },
  "claude-acp": {
    name: "Claude Agent ACP",
    minimum: "0.85.1",
    reason: "Reviewed profile claude-bridge: CLAUDE_CODE_EXECUTABLE bridge and subagent sessions.",
    verified: false,
  },
  "codex-acp": {
    name: "Codex ACP",
    minimum: "2.1.1",
    reason: "Reviewed profile codex-bridge: CODEX_PATH bridge and subagent sessions.",
    verified: false,
  },
  goose: {
    name: "Goose",
    minimum: "1.53.0",
    reason: "Reviewed profile goose-153: goose acp.",
    verified: false,
  },
  auggie: {
    name: "Auggie",
    minimum: "0.36.0",
    reason: "Reviewed profile auggie-036: --acp with auto-update disabled.",
    verified: false,
  },
  acp: {
    name: "ACP agent",
    minimum: "1.0.0",
    reason:
      "Agents without a reviewed profile have no version ace has checked; they are admitted by protocol, since initialize must answer ACP protocolVersion 1.",
    verified: true,
  },
} satisfies Record<string, CliRequirement>;

export type CliId = keyof typeof cliRequirements;

export function isCliId(value: string): value is CliId {
  return Object.hasOwn(cliRequirements, value);
}

const providerClis: Readonly<Record<string, CliId>> = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  pi: "pi",
  cursor: "cursor-sdk",
  antigravity: "antigravity",
};

/** The CLI (or, for Cursor, the bundled SDK) behind a provider kind; ACP agents go by agent. */
export function providerCli(provider: string): CliId | undefined {
  return Object.hasOwn(providerClis, provider) ? providerClis[provider] : undefined;
}

/** Where an installed CLI's version output stands against ace's minimum for it. */
export function checkCli(id: CliId, output: string | undefined): CliVersionCheck {
  return checkCliVersion(cliRequirements[id].minimum, output);
}

/** The person-facing sentence for a CLI older than ace supports. */
export function cliTooOldMessage(name: string, installed: string, required: string): string {
  return `${name} ${installed} is older than ${required}, the oldest version ace supports.`;
}

/** What the person does about it. */
export function cliUpdateHint(name: string): string {
  return `Update ${name}, then refresh.`;
}

/**
 * An installed CLI older than ace's minimum. Typed (`code: "cli_too_old"`) so discovery, session
 * start and the installer report the same structured facts: which CLI, installed, required.
 */
export class CliTooOldError extends Error {
  readonly code = "cli_too_old";
  readonly cli: CliId;
  readonly installed: string;
  readonly required: string;
  /** A failed session opening shows this as its heading. */
  readonly title: string;
  constructor(cli: CliId, installed: string, required: string) {
    const name = cliRequirements[cli].name;
    super(`${cliTooOldMessage(name, installed, required)} ${cliUpdateHint(name)}`);
    this.name = "CliTooOldError";
    this.title = `Update ${name}`;
    this.cli = cli;
    this.installed = installed;
    this.required = required;
  }
}

/** Throw `CliTooOldError` when the version output is readable and below the minimum. */
export function requireMinimum(id: CliId, output: string | undefined): void {
  const check = checkCli(id, output);
  if (check.status === "too_old") throw new CliTooOldError(id, check.installed, check.required);
}

/**
 * For a CLI whose contract binds to its reported version (capabilities gate on it): an
 * unreadable version is refused too, as `cli_unsupported`, never as "too old".
 */
export function requireReadableMinimum(id: CliId, output: string | undefined): void {
  requireMinimum(id, output);
  if (checkCli(id, output).status === "unreadable") {
    const { name, minimum } = cliRequirements[id];
    throw Object.assign(
      new Error(`${name}'s version couldn't be read. ace supports ${name} ${minimum} or newer.`),
      { code: "cli_unsupported" },
    );
  }
}

/** The version is readable and at least the minimum. */
export function admitsVersion(id: CliId, output: string | undefined): boolean {
  return checkCli(id, output).status === "ok";
}
