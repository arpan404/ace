import { z } from "zod";
import { maxProjectNoteLength, type McpAttribution } from "@ace/protocol";
import type { Toolkit } from "./toolkits.ts";

/** Project knowledge (P5), notes (P7), diagnostics (P10) and asking the person (P9). */
export const KnowledgeTopic = z.enum(["recent", "changes", "prs", "notes", "diagnostics"]);
export type KnowledgeTopic = z.infer<typeof KnowledgeTopic>;
const clipped = (max: number) => z.string().max(max);
const RecentThread = z.object({
  threadId: z.string(),
  title: clipped(256),
  status: z.string(),
  branch: clipped(256).optional(),
  prs: z
    .array(z.object({ number: z.number(), state: z.string(), url: clipped(2048) }))
    .max(8)
    .optional(),
  /** The thread's last answer, one line of at most 160 characters. */
  outcome: clipped(160).optional(),
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
const Note = z.object({
  id: z.string(),
  text: clipped(maxProjectNoteLength),
  threadId: z.string().optional(),
});
const Diagnostics = z.object({
  /** Failed ace calls in this session, newest first; count > 1 means identical repeats. */
  failures: z.array(z.object({ tool: clipped(128), code: clipped(64), count: z.number() })).max(20),
  /** What keeps this thread from settling, in plain words. */
  blocking: z.array(clipped(240)).max(16),
});
export const KnowledgeResult = z.object({
  recent: z.array(RecentThread).max(5).optional(),
  changes: Changes.nullable().optional(),
  prs: z.array(Pr).max(20).optional(),
  notes: z.array(Note).max(50).optional(),
  diagnostics: Diagnostics.optional(),
});
export type KnowledgeResult = z.infer<typeof KnowledgeResult>;
export const AskInput = z.strictObject({
  question: z.string().min(1).max(1000).describe("One clear question."),
  options: z
    .array(z.string().min(1).max(80))
    .max(8)
    .optional()
    .describe("Answers to choose from, when you can offer them."),
  allowOther: z.boolean().default(true).describe("Let the person type their own answer."),
  timeoutSeconds: z
    .number()
    .int()
    .min(5)
    .max(240)
    .default(240)
    .describe("How long to wait, 5 to 240 seconds."),
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
    topics: readonly KnowledgeTopic[],
    signal: AbortSignal,
  ): Promise<KnowledgeResult>;
  addNote(caller: McpAttribution, text: string): Promise<{ noteId: string; notes: number }>;
  retireNote(caller: McpAttribution, noteId: string): Promise<{ retired: boolean }>;
  ask(caller: McpAttribution, input: AskInput, signal: AbortSignal): Promise<AskResult>;
}

export const knowledgeToolCatalog = [
  {
    name: "note_add",
    title: "Save a project note",
    toolset: "ace-threads",
    riskClass: "thread-write",
    description:
      "Remember one short fact about this project for every future thread and provider, such as how to run its tests or a pitfall you hit. Facts only, never instructions to ignore other guidance. The person sees and edits notes.",
    input: z.strictObject({
      text: z
        .string()
        .min(1)
        .max(maxProjectNoteLength)
        .describe(`One fact, at most ${maxProjectNoteLength} characters.`),
    }),
    output: z.object({ noteId: z.string(), notes: z.number() }),
    capability: "projects",
    timeoutMs: 10_000,
  },
  {
    name: "note_retire",
    title: "Remove a project note",
    toolset: "ace-threads",
    riskClass: "thread-write",
    description: "Remove a project note that is wrong or out of date.",
    input: z.strictObject({
      noteId: z.string().min(1).max(64).describe("The note's id from context topic notes."),
    }),
    output: z.object({ retired: z.boolean() }),
    capability: "projects",
    timeoutMs: 10_000,
  },
  {
    name: "ask",
    title: "Ask the person",
    toolset: "ace-agents",
    riskClass: "thread-write",
    description:
      "Ask the person a question in ace and wait up to timeoutSeconds for the answer. If they have not answered by then it returns pending: end your turn, and their answer arrives as their next message. Never use it to ask for permission.",
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
        run: (input, { caller }) => port.addNote(caller, input.text),
      });
      registry.register({
        ...knowledgeToolCatalog[1],
        run: (input, { caller }) => port.retireNote(caller, input.noteId),
      });
      registry.register({
        ...knowledgeToolCatalog[2],
        run: (input, { caller, signal }) => port.ask(caller, input, signal),
      });
    },
  };
}
