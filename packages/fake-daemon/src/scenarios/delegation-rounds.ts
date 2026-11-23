import type { Fact } from "@ace/core";
import { ThreadId, type RunTrigger, type ThreadStatus } from "@ace/protocol";
import type { Scenario } from "../scenario.ts";
import { fixtureImage } from "../attachment-fixture.ts";
import { message, rootAgent, tool, toolDone } from "./facts.ts";

const cwd = "/Users/dev/acme";
export const delegationRoundsIds = {
  parent: "thread-delegation-rounds",
  accounts: "thread-rounds-accounts",
  mockups: "thread-rounds-mockups",
  review: "thread-rounds-review",
} as const;
type Child = Exclude<keyof typeof delegationRoundsIds, "parent">;

const minute = 60_000;

const started = (run: string, trigger: RunTrigger): Fact => ({
  type: "turn.started",
  agent: "root",
  nativeTurnId: run,
  trigger,
});
const ended = (run: string): Fact => ({
  type: "turn.ended",
  agent: "root",
  nativeTurnId: run,
  outcome: "completed",
});
const shell = (key: string, command: string): Fact[] => [
  tool("root", key, { kind: "shell", title: command, detail: { kind: "shell", command } }),
  toolDone("root", key),
];
const aceCall = (key: string, name: string, args: Record<string, unknown> = {}): Fact[] => [
  tool("root", key, {
    kind: "mcp",
    title: `mcp__ace__${name}`,
    detail: { kind: "mcp", server: "ace", tool: name, arguments: args },
  }),
  toolDone("root", key),
];
const image = (key: string, caption: string): Fact => ({
  type: "item.upsert",
  agent: "root",
  item: key,
  draft: {
    type: "image",
    complete: true,
    image: {
      alt: caption,
      caption,
      attachment: {
        sha256: fixtureImage.sha256,
        bytes: atob(fixtureImage.data).length,
        name: "mockup.png",
        mimeType: "image/png",
        kind: "image",
        width: 120,
        height: 80,
        thumbnailAvailable: true,
      },
    },
  },
});

const titles: Record<Child, string> = {
  accounts: "Build-provider-accounts",
  mockups: "Design-providers-mockups",
  review: "Review-accounts-security",
};
const results: Record<Child, string> = {
  accounts: "Fixed both findings and pushed them.",
  mockups: "Built mockups A (drill-in list) and B (two panes) at /tmp/mockups.",
  review: "Two blocking findings: tokens outlive sign-out; removal skips the stamp check.",
};

/** The launch card, as ace keeps it up to date while the child works and once it settles. */
function card(child: Child, done: boolean): Fact {
  const threadId = ThreadId.parse(delegationRoundsIds[child]);
  return {
    type: "item.upsert",
    agent: "root",
    item: `launch-${child}`,
    draft: {
      type: "delegation.started",
      origin: "ace",
      childThreadId: threadId,
      provider: child === "review" ? "codex" : "claude",
      model: child === "review" ? "gpt-6.2-sol" : "claude-opus-5-5",
      title: titles[child],
      role: titles[child],
      phase: done ? "settled" : "running",
      status: done ? { state: "done" } : { state: "working", agents: 1 },
      updatedAt: done ? 2000 : 1000,
      generation: 0,
      complete: done,
      outcome: done
        ? { threadId, outcome: "completed", result: results[child], truncated: false, before: null }
        : null,
    },
  };
}
function launch(child: Child): Fact[] {
  const status: ThreadStatus = { state: "working", agents: 1 };
  return [
    card(child, false),
    {
      type: "agent.seen",
      agent: `child-${child}`,
      parent: "root",
      origin: "ace",
      fidelity: "full",
      native: { provider: child === "review" ? "codex" : "claude", nativeId: child },
      cwd,
      name: titles[child],
    },
    {
      type: "agent.external",
      agent: `child-${child}`,
      threadId: ThreadId.parse(delegationRoundsIds[child]),
      status,
    },
  ];
}
/** The child finished: its card settles, and ace hands its result to the parent. */
function reportBack(child: Child): Fact[] {
  const threadId = ThreadId.parse(delegationRoundsIds[child]);
  return [
    { type: "agent.external", agent: `child-${child}`, threadId, status: { state: "done" } },
    card(child, true),
    {
      type: "item.upsert",
      agent: "root",
      item: `back-${child}`,
      draft: {
        type: "delegation.settled",
        origin: "ace",
        delivery: "ace-input",
        complete: true,
        results: [
          {
            threadId,
            outcome: "completed",
            result: results[child],
            truncated: false,
            before: null,
          },
        ],
      },
    },
  ];
}

function childThread(child: Child, done: boolean): Scenario {
  return {
    thread: {
      id: delegationRoundsIds[child],
      workspaceId: "acme",
      title: titles[child],
      provider: child === "review" ? "codex" : "claude",
      parentThreadId: delegationRoundsIds.parent,
    },
    steps: [
      {
        kind: "facts",
        agoMs: 40 * minute,
        facts: [
          rootAgent(child === "review" ? "codex" : "claude", cwd),
          started("task", "spawn"),
          {
            type: "item.upsert",
            agent: "root",
            item: "task",
            draft: {
              type: "message",
              role: "user",
              complete: true,
              parts: [{ type: "text", text: `Role: ${titles[child]}\n\nTask:\n${results[child]}` }],
              origin: {
                kind: "spawn",
                parentThreadId: ThreadId.parse(delegationRoundsIds.parent),
                role: titles[child],
              },
            },
          },
          ...(done
            ? [message("root", "result", "assistant", results[child]), ended("task")]
            : [message("root", "progress", "assistant", "Working through the findings.", false)]),
        ],
      },
    ],
  };
}

/**
 * A parent that delegates in rounds (the thread behind "the last turn is hard to read"): one ask
 * starts three children; two of them report back, and each report wakes the parent for a short
 * run of its own (mockup screenshots it posts between steps, a review it forwards). One child,
 * the accounts build, is still working, so the turn's tree has not settled though the parent
 * itself has stopped.
 */
export function delegationRounds(): Scenario[] {
  const parent: Scenario = {
    thread: {
      id: delegationRoundsIds.parent,
      workspaceId: "acme",
      title: "Providers page and accounts",
      provider: "claude",
    },
    steps: [
      {
        kind: "facts",
        agoMs: 41 * minute,
        facts: [
          rootAgent("claude", cwd),
          started("ask-run", "user"),
          message(
            "root",
            "ask",
            "user",
            "Mock up two designs for the providers page, and keep the accounts work moving.",
          ),
          ...shell("status", "git status --short"),
          ...shell("read-settings", "rg -n 'Providers' apps/web/src/features/settings"),
          ...launch("accounts"),
          ...launch("mockups"),
          message(
            "root",
            "started",
            "assistant",
            "Both are started: the accounts build and the mockups. I'll look at the mockups when they land.",
          ),
          ended("ask-run"),
        ],
      },
      {
        kind: "facts",
        agoMs: 20 * minute,
        facts: [
          started("mockups-back", "subagent_result"),
          ...reportBack("mockups"),
          message(
            "root",
            "posting",
            "assistant",
            "The mockups are done. Posting screenshots as I click through them.",
          ),
          ...aceCall("open", "browser_open", { url: "http://localhost:4173/a.html" }),
          ...aceCall("shot-a", "image_show", { path: "a-overview.png" }),
          image("image-a", "A · Overview"),
          ...aceCall("click-a", "browser_act", { ref: "provider" }),
          ...aceCall("shot-a2", "image_show", { path: "a-provider.png" }),
          image("image-a2", "A · A provider"),
          message("root", "next", "assistant", "Mockup A is posted. Now mockup B, the two panes."),
          ...aceCall("open-b", "browser_open", { url: "http://localhost:4173/b.html" }),
          ...aceCall("shot-b", "image_show", { path: "b-overview.png" }),
          image("image-b", "B · Overview"),
          ...shell("stop-server", "kill %1"),
          ...launch("review"),
          message(
            "root",
            "mockups-answer",
            "assistant",
            "Both directions are mocked up: A is a drill-in list, B is two panes. A security review of the accounts work is running.",
          ),
          ended("mockups-back"),
        ],
      },
      {
        kind: "facts",
        agoMs: 3 * minute,
        facts: [
          started("review-back", "subagent_result"),
          ...reportBack("review"),
          message(
            "root",
            "forwarding",
            "assistant",
            "The review found two blocking problems. Sending them to the accounts thread.",
          ),
          ...aceCall("read-accounts", "thread_read", { threadId: delegationRoundsIds.accounts }),
          ...aceCall("send-accounts", "agent_message", {
            threadId: delegationRoundsIds.accounts,
          }),
          message(
            "root",
            "review-answer",
            "assistant",
            "The security review found two blocking problems: tokens outlive sign-out, and removing an account skips the stamp check. I sent both to the accounts thread, which is fixing them now.",
          ),
          ended("review-back"),
        ],
      },
    ],
  };
  return [
    parent,
    childThread("accounts", false),
    childThread("mockups", true),
    childThread("review", true),
  ];
}
