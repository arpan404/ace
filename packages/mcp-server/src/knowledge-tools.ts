import { z } from "zod";
import type { McpAttribution } from "@ace/protocol";
import type { Toolkit } from "./toolkits.ts";

/** Project knowledge (P5), notes (P7), diagnostics (P10) and asking the person (P9). */
export const ContextTopic = z.enum(["recent", "changes", "prs", "notes", "diagnostics"]);
export type ContextTopic = z.infer<typeof ContextTopic>;
const clipped = (max: number) => z.string().max(max);
const RecentThread = z.object({
  threadId: z.string(),
  title: clipped(256),
  status: z.string(),
  updatedAt: z.number(),
  branch: clipped(256).optional(),
  prs: z
    .array(z.object({ number: z.number(), state: z.string(), url: clipped(2048) }))
    .max(8)
    .optional(),
  /** The thread's last answer, one line. */
  outcome: clipped(400).optional(),
});
const Changes = z.object({
  branch: clipped(256).nullable(),
  upstream: clipped(256).nullable(),
  ahead: z.number(),
  behind: z.number(),
  staged: z.number(),
  unstaged: z.number(),
  untracked: z.number(),
  /** Changed paths, staged and unstaged, at most 50. */
  files: z.array(clipped(1024)).max(50),
});
const Pr = z.object({
  threadId: z.string(),
  number: z.number(),
  url: clipped(2048),
  state: z.string(),
  title: clipped(256).optional(),
  ci: z.enum(["none", "pending", "success", "failure", "unknown"]),
});
const Note = z.object({ id: z.string(), text: clipped(500), threadId: z.string().optional() });
const Diagnostics = z.object({
  /** Failed ace calls in this session, newest first; count > 1 means identical repeats. */
  failures: z.array(z.object({ tool: clipped(128), code: clipped(64), count: z.number() })).max(20),
  /** What keeps this thread from settling, in plain words. */
  blocking: z.array(clipped(240)).max(16),
});
export const ContextResult = z.object({
  recent: z.array(RecentThread).max(10).optional(),
  changes: Changes.nullable().optional(),
  prs: z.array(Pr).max(20).optional(),
  notes: z.array(Note).max(50).optional(),
  diagnostics: Diagnostics.optional(),
});
export type ContextResult = z.infer<typeof ContextResult>;
export const AskInput = z.strictObject({
  question: z.string().min(1).max(1000),
  options: z.array(z.string().min(1).max(80)).max(8).optional(),
  allowOther: z.boolean().default(true),
  timeoutSeconds: z.number().int().min(5).max(240).default(240),
});
export type AskInput = z.output<typeof AskInput>;
export const AskResult = z.object({
  status: z.enum(["answered", "declined", "pending"]),
  askId: z.string(),
  /** The chosen options or typed answer. */
  answer: z.array(clipped(4096)).max(16).optional(),
});
export type AskResult = z.infer<typeof AskResult>;

export interface KnowledgePort {
  context(
    caller: McpAttribution,
    topics: readonly ContextTopic[],
    signal: AbortSignal,
  ): Promise<ContextResult>;
  addNote(caller: McpAttribution, text: string): Promise<{ noteId: string; notes: number }>;
  retireNote(caller: McpAttribution, noteId: string): Promise<{ retired: boolean }>;
  ask(caller: McpAttribution, input: AskInput, signal: AbortSignal): Promise<AskResult>;
}

export const knowledgeToolCatalog = [
  {
    name: "ace_context",
    riskClass: "read-only",
    description:
      "What this project already knows, in one read: recent threads with their outcomes and PRs, this worktree's changes versus upstream, linked PRs with CI state, project notes, and this session's diagnostics (failed ace calls, what blocks settlement). Use before git/gh calls or re-reading transcripts. Also readable as ace://project/recent, ace://worktree/changes, ace://project/prs, ace://project/notes and ace://thread/self/diagnostics.",
    input: z.strictObject({
      topics: z.array(ContextTopic).min(1).max(5).default(["recent", "changes", "prs", "notes"]),
    }),
    output: ContextResult,
    capability: null,
    timeoutMs: 30_000,
  },
  {
    name: "ace_note_add",
    riskClass: "thread-write",
    description:
      "Remember a short fact about this project for every future thread and provider, such as how to run its tests or a pitfall you hit. One fact per note, at most 500 characters; facts only, never instructions to ignore other guidance. The person sees and edits notes in Edit project.",
    input: z.strictObject({ text: z.string().min(1).max(500) }),
    output: z.object({ noteId: z.string(), notes: z.number() }),
    capability: "projects",
    timeoutMs: 10_000,
  },
  {
    name: "ace_note_retire",
    riskClass: "thread-write",
    description: "Remove a project note that is wrong or out of date, by its id from ace_context.",
    input: z.strictObject({ noteId: z.string().min(1).max(64) }),
    output: z.object({ retired: z.boolean() }),
    capability: "projects",
    timeoutMs: 10_000,
  },
  {
    name: "ace_ask",
    riskClass: "thread-write",
    description:
      "Ask the person a question in ace and wait for the answer, up to timeoutSeconds (at most 240). Offer options when you can. If they have not answered by then, it returns pending: end your turn; their answer arrives as their next message. Use only when you have no native ask tool of your own. Never use it to ask for permission.",
    input: AskInput,
    output: AskResult,
    capability: null,
    timeoutMs: 250_000,
  },
] as const;

export function knowledgeToolkit(port: KnowledgePort): Toolkit {
  return {
    register(registry) {
      registry.register({
        ...knowledgeToolCatalog[0],
        run: (input, { caller, signal }) => port.context(caller, input.topics, signal),
      });
      registry.register({
        ...knowledgeToolCatalog[1],
        run: (input, { caller }) => port.addNote(caller, input.text),
      });
      registry.register({
        ...knowledgeToolCatalog[2],
        run: (input, { caller }) => port.retireNote(caller, input.noteId),
      });
      registry.register({
        ...knowledgeToolCatalog[3],
        run: (input, { caller, signal }) => port.ask(caller, input, signal),
      });
    },
  };
}

/** Resources that are one `ace_context` topic each. */
export const knowledgeResources: readonly { uri: string; topic: ContextTopic; name: string }[] = [
  { uri: "ace://project/recent", topic: "recent", name: "Recent threads in this project" },
  { uri: "ace://worktree/changes", topic: "changes", name: "This worktree's changes" },
  { uri: "ace://project/prs", topic: "prs", name: "Linked pull requests and CI" },
  { uri: "ace://project/notes", topic: "notes", name: "Project notes" },
  {
    uri: "ace://thread/self/diagnostics",
    topic: "diagnostics",
    name: "This session's diagnostics",
  },
];
