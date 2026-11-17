import { after, grammarRelease as since, idempotencyKey, limit } from "./flags.ts";
import type { CommandSpec, FlagSpec } from "./spec.ts";

/** Requests (what needs the person) and projects (ADR 0178 §7, Work). */

const requestArg = {
  name: "REQUEST",
  summary: "A request id, or at least 6 characters of one; picked on a terminal when omitted",
  ref: "request",
} as const;
const threadFlag: FlagSpec = {
  name: "thread",
  value: "THREAD",
  summary: "The thread whose one open request to answer",
  ref: "thread",
};
const optionFlag: FlagSpec = {
  name: "option",
  value: "ID",
  summary: "One of the request's own options",
};
const hiddenRequest: FlagSpec = {
  name: "request",
  value: "REQUEST",
  summary: "Same as REQUEST",
  ref: "request",
  hidden: true,
};
const feedback: FlagSpec = {
  name: "feedback",
  value: "TEXT",
  summary: "Why, sent back to the agent (plans and questions)",
};
const projectArg = {
  name: "PROJECT",
  summary: "A project id, name or path",
  required: true,
  ref: "project",
} as const;

export const requestCommands: readonly CommandSpec[] = [
  {
    id: "request.list",
    words: ["request", "list"],
    summary: "Every open approval, question and plan, across threads",
    group: "work",
    nounDefault: true,
    flags: [{ ...threadFlag, summary: "Only this thread's and its agents'" }],
    aliases: [{ words: ["requests"], quiet: true }],
    examples: [
      { command: "ace request list", summary: "What needs you" },
      { command: "ace request list --quiet", summary: "Their ids, one per line" },
    ],
    output: "request.list",
  },
  {
    id: "request.show",
    words: ["request", "show"],
    summary: "One request in full: what it asks and its choices",
    group: "work",
    args: [requestArg],
    output: "request.show",
  },
  {
    id: "request.allow",
    personOnly: "answer",
    words: ["request", "allow"],
    summary: "Allow a pending approval or plan",
    group: "work",
    mutates: true,
    args: [requestArg],
    flags: [
      threadFlag,
      { name: "always", summary: "Allow it from now on, where the request offers that" },
      optionFlag,
      hiddenRequest,
      idempotencyKey,
    ],
    aliases: [
      {
        words: ["thread", "approve"],
        deprecatedSince: since,
        wordsAs: ["thread"],
        renameFlags: { interaction: "request" },
      },
    ],
    examples: [
      { command: "ace request allow", summary: "Pick one of the open requests" },
      { command: "ace request allow i_4b1d0e --always", summary: "Allow it from now on" },
    ],
    output: "receipt",
  },
  {
    id: "request.deny",
    personOnly: "answer",
    words: ["request", "deny"],
    summary: "Deny a pending approval, plan or question",
    group: "work",
    mutates: true,
    args: [requestArg],
    flags: [threadFlag, optionFlag, feedback, hiddenRequest, idempotencyKey],
    aliases: [
      {
        words: ["thread", "deny"],
        deprecatedSince: since,
        wordsAs: ["thread"],
        renameFlags: { interaction: "request" },
      },
    ],
    output: "receipt",
  },
  {
    id: "request.answer",
    personOnly: "answer",
    words: ["request", "answer"],
    summary: "Answer an agent's question",
    description:
      "Pick choices with --choice (QUESTION=ID when it asks several), or type an answer where the question takes one. On a terminal, missing answers are asked for.",
    group: "work",
    mutates: true,
    args: [requestArg, { name: "TEXT", summary: "A typed answer; - reads stdin", stdin: true }],
    flags: [
      threadFlag,
      {
        name: "choice",
        value: "ID",
        summary: "A choice, or QUESTION=ID; repeat for more",
        repeat: true,
      },
      hiddenRequest,
      idempotencyKey,
    ],
    examples: [
      { command: "ace request answer i_4b1d0e --choice postgres", summary: "Pick a choice" },
      {
        command: 'ace request answer i_4b1d0e "Use the staging bucket"',
        summary: "Type the answer",
      },
    ],
    output: "receipt",
  },
];

export const projectCommands: readonly CommandSpec[] = [
  {
    id: "project.list",
    words: ["project", "list"],
    summary: "Your projects",
    group: "work",
    nounDefault: true,
    flags: [limit, after],
    aliases: [{ words: ["projects"], quiet: true }],
    output: "project.list",
  },
  {
    id: "project.show",
    words: ["project", "show"],
    summary: "One project: its folder, git and threads",
    group: "work",
    args: [
      {
        ...projectArg,
        required: false,
        summary: "A project id, name or path; this folder when omitted",
      },
    ],
    output: "project.show",
  },
  {
    id: "project.add",
    words: ["project", "add"],
    summary: "Register a folder as a project",
    group: "work",
    mutates: true,
    args: [{ name: "PATH", summary: "The folder; this one when omitted" }],
    flags: [idempotencyKey],
    aliases: [{ words: ["add"], deprecatedSince: since }],
    output: "receipt",
  },
  {
    id: "project.rename",
    words: ["project", "rename"],
    summary: "Rename a project",
    group: "work",
    mutates: true,
    args: [projectArg, { name: "NAME", summary: "Its new name", required: true }],
    flags: [idempotencyKey],
    output: "receipt",
  },
  {
    id: "project.remove",
    words: ["project", "remove"],
    summary: "Stop tracking a project; its files stay",
    group: "work",
    mutates: true,
    args: [projectArg],
    flags: [{ name: "stop-threads", summary: "Stop its running threads first" }, idempotencyKey],
    output: "receipt",
  },
  {
    id: "project.open",
    words: ["project", "open"],
    summary: "Open a project in the app",
    group: "work",
    mutates: true,
    args: [
      {
        name: "PROJECT",
        summary: "A project id, name or folder; this folder when omitted",
        ref: "project",
      },
    ],
    flags: [{ name: "web", summary: "Open the web app, not the desktop app" }, idempotencyKey],
    aliases: [{ words: ["open"] }],
  },
];
