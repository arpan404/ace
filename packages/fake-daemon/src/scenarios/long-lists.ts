import {
  CommandId,
  DeviceId,
  ForgeIssueDetail,
  ThreadId,
  WorkspaceId,
  type ForgeInboxRow,
} from "@ace/protocol";
import { sketchPullRequests, type PrSketch } from "../catalog/forge-browse.ts";
import type { PullRequestFixture } from "../catalog/pull-request-details.ts";
import type { FakeDaemon } from "../daemon.ts";
import type { ServicesSeed } from "../services-wire.ts";
import type { SkillSeed } from "../skill-library.ts";

/*
 * Lists far longer than a screen, for measuring and testing the app's long lists (Skills,
 * Automations, Pull requests, Issues, the Code review inbox, History): `count` of each, or as
 * many as the wire carries where it caps a list (1,024 skills; 1,000 of the person's
 * automations and 1,000 the agents made).
 */

const minute = 60_000;
const iso = (at: number) => new Date(Math.max(0, at)).toISOString();
const pad = (n: number) => String(n).padStart(4, "0");
const repository = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;

/**
 * `count` open pull requests of `acme/ace`, one a minute apart, newest first, all by one other
 * person, so they list in one group in the order they were made.
 */
export function longPullRequests(now: number, count: number): PullRequestFixture[] {
  const sketches: PrSketch[] = Array.from({ length: count }, (_, n) => ({
    number: 10_000 + n,
    title: `Long list change ${pad(n + 1)}`,
    state: "open",
    author: "sam",
    reviewers: ["mira"],
    decision: "REVIEW_REQUIRED",
    ci: "success",
    updated: (n + 1) * minute,
    branch: `long/${n + 1}`,
    body: "",
    files: [["src/a.ts", 1, 0]],
  }));
  return sketchPullRequests(now, sketches);
}

/** `count` open issues of `acme/ace` by one other person, as the daemon's issue reads answer them. */
export function longIssues(now: number, count: number): ForgeIssueDetail[] {
  return Array.from({ length: count }, (_, n) =>
    ForgeIssueDetail.parse({
      ref: { repository, number: 20_000 + n },
      title: `Long list issue ${pad(n + 1)}`,
      url: `https://github.com/acme/ace/issues/${20_000 + n}`,
      author: "mira",
      state: "open",
      labels: [],
      labelColors: {},
      assignees: [],
      milestone: null,
      createdAt: iso(now - (n + 1) * minute - minute),
      updatedAt: iso(now - (n + 1) * minute),
      body: "",
      permissions: { edit: true, close: true, reopen: true, comment: true, reason: "" },
      relatedThreads: [],
      relatedThreadsTruncated: false,
    }),
  );
}

/**
 * `count` unread GitHub notifications about `acme/ace`'s pull requests, newest first. GitHub
 * pages at most 1,000 of them (20 pages of 50).
 */
export function longInbox(now: number, count: number): ForgeInboxRow[] {
  return Array.from({ length: count }, (_, n) => ({
    id: String(50_000 + n),
    repository,
    type: "PullRequest",
    title: `Long list notification ${pad(n + 1)}`,
    reason: n % 2 ? "review_requested" : "mention",
    unread: true,
    updatedAt: iso(now - (n + 1) * minute),
    lastReadAt: null,
    url: `https://github.com/acme/ace/pull/${10_000 + n}`,
    number: 10_000 + n,
    state: "open",
  }));
}

/** The most skills a list carries on the wire. */
export const longSkillCount = 1_024;

/** As many personal skills as the wire carries, or `count` if fewer. */
export function longSkills(count: number): SkillSeed[] {
  return Array.from({ length: Math.min(count, longSkillCount) }, (_, n) => ({
    name: `long-skill-${pad(n + 1)}`,
    description: `Skill number ${n + 1} of a long library.`,
    body: `# Long skill ${pad(n + 1)}\n\nUse it.\n`,
    scope: "personal",
  }));
}

/**
 * `seed` with its automations copied up to `count` in all: half the person's, half made by
 * agents in threads, each half capped at what the wire carries (1,000).
 */
export function withLongAutomations(seed: ServicesSeed, count: number): ServicesSeed {
  const [own] = seed.automations ?? [];
  const [made] = seed.threadAutomations ?? [];
  const half = Math.min(1_000, Math.ceil(count / 2));
  return {
    ...seed,
    ...(own && {
      automations: Array.from({ length: half }, (_, n) => ({
        ...own,
        id: `auto-long-${pad(n + 1)}`,
        title: `Long automation ${pad(n + 1)}`,
      })),
    }),
    ...(made && {
      threadAutomations: Array.from({ length: half }, (_, n) => ({
        ...made,
        automation: {
          ...made.automation,
          id: `thread-long-${pad(n + 1)}`,
          title: `Agent automation ${pad(n + 1)}`,
        },
      })),
    }),
  };
}

/** `count` threads of `workspaceId`, each settled, so History holds them all. */
export function seedSettledThreads(daemon: FakeDaemon, count: number, workspaceId = "ace"): void {
  for (let n = 0; n < count; n++) {
    const id = `thread-long-settled-${pad(n + 1)}`;
    daemon.createThread(
      {
        id,
        workspaceId: WorkspaceId.parse(workspaceId),
        title: `Settled long ago ${pad(n + 1)}`,
        provider: "claude",
        // A thread never sent to is an unsent draft, which lists leave out.
        hasSentMessage: true,
      },
      (n + 1) * minute,
    );
    daemon.command({
      id: CommandId.parse(`settle-${id}`),
      deviceId: DeviceId.parse("long-lists"),
      payload: { type: "thread.settle", threadId: ThreadId.parse(id) },
    });
  }
}

/**
 * Every long list at once, for `?fakeLists=` in the fake app: pull requests and notifications
 * in place of the seeded ones, issues beside them, the long skills library and settled threads.
 * Automations go through `withLongAutomations`, since they arrive with the services seed.
 */
export function seedLongLists(daemon: FakeDaemon, now: number, count: number): void {
  daemon.workspace.seedPullRequests(longPullRequests(now, count));
  const workspaceId = WorkspaceId.parse("ace");
  for (const issue of longIssues(now, count))
    daemon.workspace.setForgeRead(
      { op: "forge.issue.detail", workspaceId, number: issue.ref.number },
      { resource: "issueDetail", value: issue },
    );
  daemon.workspace.inbox.seed(longInbox(now, count));
  daemon.skills.seed(longSkills(count));
  seedSettledThreads(daemon, count);
}
