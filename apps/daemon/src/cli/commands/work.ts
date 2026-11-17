import {
  after,
  grammarRelease as since,
  idempotencyKey,
  limit,
  modelName,
  projectRef,
  providerName,
  follow,
} from "./flags.ts";
import type { CommandSpec, NounSpec } from "./spec.ts";
import { projectCommands, requestCommands } from "./work-requests.ts";

/** Threads, what needs the person, and projects (ADR 0176 §7, Work). */
export const workNouns: readonly NounSpec[] = [
  { name: "thread", summary: "Start, follow, steer and stop agent threads", group: "work" },
  { name: "request", summary: "Approvals, questions and plans waiting for you", group: "work" },
  { name: "project", summary: "Folders ace works in", group: "work" },
];

const thread = "THREAD";
const threadSummary = "A thread id, or at least 6 characters of one";
const threadArg = { name: thread, ref: "thread", summary: threadSummary, required: true } as const;

/** One thread, then the thread's organising verb (`settle`, `resume`…). */
function organise(verb: string, summary: string, extra: Partial<CommandSpec> = {}): CommandSpec {
  return {
    id: `thread.${verb}`,
    words: ["thread", verb],
    summary,
    group: "work",
    mutates: true,
    args: [threadArg],
    flags: [idempotencyKey],
    output: "receipt",
    ...extra,
  };
}

const threadCommands: readonly CommandSpec[] = [
  {
    id: "thread.list",
    words: ["thread", "list"],
    summary: "Your threads, in the app's order",
    description:
      "Pinned first, then what needs you, what runs, what finished unseen and the rest. Settled and snoozed threads are left out unless asked for.",
    group: "work",
    nounDefault: true,
    flags: [
      projectRef,
      { name: "needs-you", summary: "Only threads waiting on you" },
      { name: "running", summary: "Only threads at work" },
      { name: "settled", summary: "Only settled threads" },
      limit,
      after,
    ],
    aliases: [
      { words: ["threads"], quiet: true },
      { words: ["threads", "list"], deprecatedSince: since },
    ],
    examples: [
      { command: "ace thread list", summary: "Every thread" },
      { command: "ace thread list --needs-you --quiet", summary: "Ids of threads waiting on you" },
      { command: "ace thread list --project ace --json", summary: "One project's, as JSON" },
    ],
    output: "thread.list",
  },
  {
    id: "thread.show",
    words: ["thread", "show"],
    summary: "One thread's transcript, requests and state",
    description: "Without THREAD on a terminal, offers a list of threads to pick from.",
    group: "work",
    args: [{ name: thread, ref: "thread", summary: threadSummary }],
    flags: [
      { name: "items", value: "N", summary: "Show the last N items (default 20, at most 200)" },
      { name: "before", value: "CURSOR", summary: "The items before this cursor (from Earlier:)" },
    ],
    aliases: [{ words: ["thread", "read"], deprecatedSince: since }],
    examples: [
      { command: "ace thread show t_9f2c41", summary: "Read a thread" },
      { command: "ace thread show t_9f2c41 --items 50", summary: "More of it" },
    ],
    output: "thread.show",
  },
  {
    id: "thread.start",
    words: ["thread", "start"],
    summary: "Start an agent on a prompt",
    description:
      "Registers the project when given a path, then starts a thread on your default provider from Settings. Without a prompt on a terminal it asks for one; elsewhere pass the prompt or - to read it from stdin.",
    group: "work",
    mutates: true,
    args: [{ name: "PROMPT", summary: "What to do; - reads stdin", required: true, stdin: true }],
    flags: [
      projectRef,
      providerName,
      modelName,
      { name: "worktree", summary: "Work in a new git worktree" },
      {
        name: "parent",
        value: "THREAD",
        ref: "thread",
        summary: "Start it as a child of this thread",
      },
      { name: "role", value: "ROLE", summary: "The child's role, shown in its parent's tree" },
      follow,
      idempotencyKey,
    ],
    aliases: [{ words: ["run"] }, { words: ["task", "spawn"], deprecatedSince: since }],
    examples: [
      { command: 'ace run "Fix the flaky upload test"', summary: "Start in this folder" },
      {
        command: "git diff | ace thread start - --provider claude --follow",
        summary: "Prompt from stdin, then follow the whole tree",
      },
    ],
    output: "thread.start",
  },
  {
    id: "thread.attach",
    words: ["thread", "attach"],
    summary: "Talk with an agent in this terminal",
    group: "work",
    mutates: true,
    args: [{ name: thread, ref: "thread", summary: "A thread to continue; omit to start one" }],
    flags: [
      projectRef,
      providerName,
      modelName,
      {
        name: "thread",
        value: "THREAD",
        ref: "thread",
        summary: "Same as the THREAD argument",
        hidden: true,
      },
      idempotencyKey,
    ],
    aliases: [{ words: ["chat"] }],
    examples: [
      { command: "ace chat", summary: "A new conversation in this folder" },
      { command: "ace chat t_9f2c41", summary: "Continue a thread" },
    ],
  },
  {
    id: "thread.send",
    words: ["thread", "send"],
    summary: "Queue a message for when the agent's turn ends",
    group: "work",
    mutates: true,
    args: [
      threadArg,
      { name: "TEXT", summary: "The message; - reads stdin", required: true, stdin: true },
    ],
    flags: [idempotencyKey],
    output: "receipt",
  },
  {
    id: "thread.steer",
    words: ["thread", "steer"],
    summary: "Send a message into the agent's current turn",
    group: "work",
    mutates: true,
    args: [
      threadArg,
      { name: "TEXT", summary: "The message; - reads stdin", required: true, stdin: true },
    ],
    flags: [idempotencyKey],
    output: "receipt",
  },
  {
    id: "thread.stop",
    words: ["thread", "stop"],
    summary: "Stop a thread and every agent under it",
    group: "work",
    mutates: true,
    args: [{ name: thread, ref: "thread", summary: "The thread to stop" }],
    flags: [
      { name: "all", summary: "Stop all running work" },
      { ...providerName, summary: "With --all, only this provider's work" },
      { ...projectRef, summary: "With --all, only this project's work" },
      {
        name: "thread",
        value: "THREAD",
        ref: "thread",
        summary: "Same as the THREAD argument",
        hidden: true,
      },
      idempotencyKey,
    ],
    aliases: [
      { words: ["thread", "cancel"], deprecatedSince: since },
      { words: ["thread", "interrupt"], deprecatedSince: since },
      { words: ["task", "cancel"], deprecatedSince: since },
      { words: ["kill-all"], deprecatedSince: since, setFlags: ["all"] },
    ],
    examples: [
      { command: "ace thread stop t_9f2c41", summary: "Stop one thread's tree" },
      { command: "ace thread stop --all --provider codex", summary: "Stop all Codex work" },
    ],
    output: "receipt",
  },
  {
    id: "thread.wait",
    words: ["thread", "wait"],
    summary: "Wait until threads finish, or until one needs you",
    description:
      "Never reports done while any agent in a tree still works or waits on a person. Exits 2 as soon as a person is needed.",
    group: "work",
    args: [
      {
        name: thread,
        ref: "thread",
        summary: "Up to 16 thread ids",
        required: true,
        variadic: true,
      },
    ],
    flags: [
      { name: "any", summary: "Return when the first one finishes" },
      { name: "all", summary: "Return when every one finishes (the default)" },
      { name: "tree", summary: "Wait for each thread's whole agent tree" },
      follow,
    ],
    aliases: [{ words: ["task", "wait"], deprecatedSince: since, setFlags: ["tree"] }],
    exits: [
      { code: 2, when: "a thread waits on a person" },
      { code: 3, when: "the timeout passed; the work may still run" },
    ],
    output: "thread.wait",
  },
  {
    id: "thread.status",
    words: ["thread", "status"],
    summary: "A thread's state; the exit code follows it",
    group: "work",
    args: [threadArg],
    aliases: [{ words: ["task", "status"], deprecatedSince: since }],
    exits: [
      { code: 2, when: "it, or an agent under it, waits on a person" },
      { code: 1, when: "it failed" },
    ],
    output: "thread.status",
  },
  {
    id: "thread.tree",
    words: ["thread", "tree"],
    summary: "A thread's agent tree: each agent and what it does",
    group: "work",
    args: [threadArg],
    output: "thread.tree",
  },
  organise("resume", "Carry on a thread that stopped at a restart or a pause"),
  organise("rename", "Give a thread a new title", {
    args: [threadArg, { name: "NAME", summary: "Its new title", required: true }],
  }),
  organise("settle", "Settle a thread: it leaves the list until it changes"),
  organise("unsettle", "Bring a settled thread back to the list"),
  organise("snooze", "Hide a thread until a time or an event", {
    flags: [
      {
        name: "until",
        value: "WHEN",
        summary: "1h, 30m, 2d, tomorrow, monday, needs-you or pr-changes",
      },
      idempotencyKey,
    ],
    examples: [
      { command: "ace thread snooze t_9f2c41 --until tomorrow", summary: "Until 9:00 tomorrow" },
      { command: "ace thread snooze t_9f2c41 --until needs-you", summary: "Until it asks" },
    ],
  }),
  organise("fork", "Start a new thread from a thread's last turn", {
    args: [
      threadArg,
      { name: "TEXT", summary: "The fork's first message; - reads stdin", stdin: true },
    ],
    flags: [{ name: "title", value: "TITLE", summary: "The new thread's title" }, idempotencyKey],
    output: "thread.fork",
  }),
  organise("model", "Switch a thread's model from its next turn", {
    args: [threadArg, { name: "MODEL", summary: "The model id", required: true }],
  }),
];

export const workCommands: readonly CommandSpec[] = [
  ...threadCommands,
  ...requestCommands,
  ...projectCommands,
];
