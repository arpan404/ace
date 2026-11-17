import type { RefKind } from "./commands/spec.ts";
import type { CommandTable } from "./commands/table.ts";
import { completionSlot, type Candidate } from "./completion.ts";

/**
 * Live references for tab completion (ADR 0176 §6): a slot the command table marks with a
 * `ref` also offers what the running daemon holds. The daemon gets a short budget; with none
 * running, an error, or no answer in time, completion offers what the table knows and nothing
 * more. Never a prompt, a start or a write: the source only reads.
 */

/**
 * Where live references come from. `reach` finds the daemon cheaply (undefined when none runs)
 * and loads what talking to it takes; that's ace's own start-up, so the budget covers only the
 * reads that follow.
 */
export interface RefSource {
  reach(): Promise<RefReader | undefined>;
}

/** The daemon's references, read only. Each read stops when `signal` aborts. */
export interface RefReader {
  threads(signal: AbortSignal): Promise<readonly { id: string; title: string }[]>;
  projects(signal: AbortSignal): Promise<readonly { id: string; name: string; path: string }[]>;
  requests(
    signal: AbortSignal,
  ): Promise<readonly { id: string; kind: string; threadTitle: string }[]>;
  bots(signal: AbortSignal): Promise<readonly { id: string; name: string; task?: string }[]>;
}

/** How long completion waits for the daemon (ADR 0176 §6). */
export const liveBudgetMs = 300;

/** The candidates for a slot of `kind`, from the source. */
export async function referenceCandidates(
  source: RefReader,
  kind: RefKind,
  signal: AbortSignal,
): Promise<Candidate[]> {
  if (kind === "thread")
    return (await source.threads(signal)).map((thread) => ({
      value: thread.id,
      description: thread.title,
    }));
  if (kind === "project")
    return (await source.projects(signal)).map((project) => spoken(project, project.path));
  if (kind === "request")
    return (await source.requests(signal)).map((request) => ({
      value: request.id,
      description: `${request.kind} in ${request.threadTitle}`,
    }));
  return (await source.bots(signal)).map((bot) => spoken(bot, bot.task));
}

/**
 * The name, which the commands accept whole, unless it holds a space: a shell would split it, so
 * the id stands in with the name beside it.
 */
function spoken(thing: { id: string; name: string }, about: string | undefined): Candidate {
  const whole = thing.name !== "" && !/\s/.test(thing.name);
  const description = whole ? about : about ? `${thing.name} · ${about}` : thing.name;
  const value = whole ? thing.name : thing.id;
  return description ? { value, description } : { value };
}

/**
 * Every candidate for the word being typed: the table's, then the daemon's for a slot that names
 * a reference, when the source answers within `budgetMs`. A source that fails or is late leaves
 * the table's alone.
 */
export async function completeLive(
  table: CommandTable,
  input: readonly string[],
  source: RefSource,
  budgetMs: number,
): Promise<Candidate[]> {
  const slot = completionSlot(table, input);
  const { ref } = slot;
  if (!ref) return [...slot.candidates];
  const reader = await source.reach().catch(() => undefined);
  const live = reader
    ? await withinBudget((signal) => referenceCandidates(reader, ref, signal), budgetMs)
    : undefined;
  const fresh = (live ?? []).filter(
    (candidate) =>
      candidate.value.startsWith(slot.current) &&
      !slot.candidates.some((known) => known.value === candidate.value),
  );
  return [...slot.candidates, ...fresh];
}

/** What `read` answers within `ms`, or undefined when it fails or is late; late work is aborted. */
async function withinBudget<T>(
  read: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T | undefined> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([read(controller.signal).catch(() => undefined), late]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
