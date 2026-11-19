import { z } from "zod";
import { isStableVersion, parseBetaTag } from "@ace/service/release-line";
import { isNewer } from "@ace/service/version";
import type { NotesLimits } from "./release-notes-check.ts";

/**
 * What the release-notes agent is given (ADR 0188), as pure decisions: the config in
 * `release/notes.json`, the range of the release (the previous published release up to this
 * tag), the PRs merged in it and how much of each the agent may read, the prompt, and the
 * command that runs Claude with no tools on the machine's own logged-in CLI (ADR 0002).
 */

export const NotesConfig = z.object({
  /**
   * Only Claude: it runs with no tools at all. An agent that can read files or run commands,
   * even sandboxed read-only, could be talked by a PR body into reading the runner's secrets.
   */
  provider: z.literal("claude"),
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high", "xhigh"]).default("medium"),
  /** The prompt, relative to the repository root, with `{{…}}` placeholders. */
  template: z.string().min(1),
  limits: z.object({
    bulletChars: z.number().int().positive(),
    bullets: z.number().int().positive(),
    totalChars: z.number().int().positive(),
  }),
  bannedTerms: z.array(z.string().min(1)),
});
export type NotesConfig = z.infer<typeof NotesConfig>;

/** A PR as `gh pr view --json number,title,body,labels,author,mergedAt,baseRefName` gives it. */
export const PullRequest = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullish(),
  labels: z.array(z.looseObject({ name: z.string() })).default([]),
  author: z.looseObject({ login: z.string() }).nullish(),
  mergedAt: z.string().nullish(),
  baseRefName: z.string().nullish(),
});
export type PullRequest = z.infer<typeof PullRequest>;

/** What the agent is shown of one PR. */
export interface PromptPullRequest {
  number: number;
  title: string;
  /** Only for an author who can write to the repository. */
  body?: string;
  labels: { name: string }[];
}

const writers = new Set(["admin", "maintain", "write"]);

/**
 * The PRs the agent reads: only those merged into main, and only the title of one whose author
 * can't write to the repository (`permissions`: login to the collaborator permission GitHub
 * reports; an unknown login can't). Bodies and labels stay editable after merge, so only people
 * already trusted with the code get to put text in front of the agent.
 */
export function promptPullRequests(
  prs: readonly PullRequest[],
  permissions: ReadonlyMap<string, string>,
): PromptPullRequest[] {
  return prs
    .filter((pr) => Boolean(pr.mergedAt) && pr.baseRefName === "main")
    .map((pr) => {
      const login = pr.author?.login;
      const trusted = login !== undefined && writers.has(permissions.get(login) ?? "none");
      if (!trusted) return { number: pr.number, title: pr.title, labels: [] };
      return {
        number: pr.number,
        title: pr.title,
        body: pr.body ?? "",
        labels: pr.labels.map((label) => ({ name: label.name })),
      };
    });
}

/** A published release's tag as an orderable version: `v1.2.3` or a beta's `1.2.3-beta.N`. */
function versionOf(tag: string): string | undefined {
  const beta = parseBetaTag(tag);
  if (beta) return `${beta.version}-beta.${beta.build}`;
  const stable = /^v(.+)$/.exec(tag)?.[1];
  return stable && isStableVersion(stable) ? stable : undefined;
}

/**
 * Where this release's notes start: the newest published release older than `tag`. A stable
 * release counts from the previous stable one, so its notes cover the whole cycle its betas
 * previewed; a beta counts from the newest earlier release of either line. Published only, not
 * every git tag: a tag that never became a release shipped nothing.
 */
export function previousReleaseTag(published: readonly string[], tag: string): string | undefined {
  const current = versionOf(tag);
  if (!current) throw new Error(`${tag} is not a release tag`);
  const stableOnly = parseBetaTag(tag) === undefined;
  let best: { tag: string; version: string } | undefined;
  for (const candidate of published) {
    const version = versionOf(candidate);
    if (!version || candidate === tag || !isNewer(current, version)) continue;
    if (stableOnly && !isStableVersion(version)) continue;
    if (!best || isNewer(version, best.version)) best = { tag: candidate, version };
  }
  return best?.tag;
}

/**
 * PR numbers from first-parent `git log --format=%s` subjects, oldest first and each once. A PR
 * lands as a merge commit ("Merge pull request #12 from …") or a squash ("Title (#12)").
 */
export function prNumbersFromLog(subjects: readonly string[]): number[] {
  const numbers = new Set<number>();
  for (const subject of subjects.toReversed()) {
    const match = /^Merge pull request #(\d+)\b/.exec(subject) ?? /\(#(\d+)\)\s*$/.exec(subject);
    if (match) numbers.add(Number(match[1]));
  }
  return [...numbers];
}

const bodyLimit = 3000;

function describePr(pr: PromptPullRequest): string {
  const labels = pr.labels.map((label) => label.name).join(", ");
  const body = (pr.body ?? "").trim();
  const clipped = body.length > bodyLimit ? `${body.slice(0, bodyLimit)}\n[…]` : body;
  return [`### #${pr.number}: ${pr.title}`, labels ? `Labels: ${labels}` : "", clipped]
    .filter(Boolean)
    .join("\n");
}

/** The agent's prompt: `template` with the release, its sections, limits and PRs filled in. */
export function notesPrompt(input: {
  template: string;
  title: string;
  kind: "beta" | "stable";
  prs: readonly PromptPullRequest[];
  limits: NotesLimits;
  /** Problems the previous attempt's notes had, for the one retry. */
  problems?: readonly string[];
}): string {
  const sections =
    input.kind === "beta" ? "New, Improved, Fixed, Known issues" : "New, Improved, Fixed";
  const values: Record<string, string> = {
    release: input.title,
    sections,
    bulletChars: String(input.limits.bulletChars),
    bullets: String(input.limits.bullets),
    prs: input.prs.length ? input.prs.map(describePr).join("\n\n") : "(no pull requests)",
  };
  let prompt = input.template.replace(
    /\{\{(\w+)\}\}/g,
    (whole, key: string) => values[key] ?? whole,
  );
  if (input.problems?.length)
    prompt += `\n\nYour previous notes were rejected for these problems; fix every one:\n${input.problems.map((problem) => `- ${problem}`).join("\n")}\n`;
  return prompt;
}

/**
 * Claude, run non-interactively with no way to act: no tools, no MCP servers, plan mode. The
 * prompt goes on stdin and the notes come back on stdout.
 */
export function notesAgentCommand(config: NotesConfig): { command: string; args: string[] } {
  return {
    command: "claude",
    args: [
      "--print",
      "--model",
      config.model,
      "--effort",
      config.effort,
      "--tools",
      "",
      "--strict-mcp-config",
      "--permission-mode",
      "plan",
      "--no-session-persistence",
      "--output-format",
      "text",
    ],
  };
}

const agentVariables = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
];

/**
 * The environment the agent runs with: only what the CLI needs to find its own login. The job's
 * GitHub token and the runner's own variables never reach it.
 */
export function agentEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of agentVariables) {
    const value = env[name];
    if (value !== undefined) kept[name] = value;
  }
  return kept;
}

/** The notes from the agent's reply: without a code fence it may have wrapped them in. */
export function notesFromReply(reply: string): string {
  const fenced = /^\s*```(?:markdown|md)?\n([\s\S]*?)\n```\s*$/.exec(reply);
  return `${(fenced?.[1] ?? reply).trim()}\n`;
}
