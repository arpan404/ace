/**
 * Whether the idle import hook watched every worker the daemon ran. The hook logs, per line:
 *   start <id>  ace's worker factory announced worker <id> (logged by its parent isolate)
 *   ack <id>    the hook ran in isolate <id> (0 is the main isolate)
 *   next <id>   at shutdown, the id the next worker would get
 * Worker ids count up from 1 across the whole process, nested workers included, so every id
 * below `next` is a worker that ran: each must have been announced and must have run the hook.
 * A worker started past the factory, alive or long retired, is a gap.
 */
export function workerCoverageGaps(log: string): string[] {
  const seen = { start: new Set<number>(), ack: new Set<number>() };
  let next: number | undefined;
  for (const line of log.split("\n")) {
    const entry = /^(start|ack|next) (\d+)$/.exec(line.trim());
    if (!entry) continue;
    const id = Number(entry[2]);
    if (entry[1] === "next") next = id;
    else if (entry[1] === "start") seen.start.add(id);
    else seen.ack.add(id);
  }
  if (next === undefined) return ["the daemon's workers were never counted"];
  const gaps: string[] = [];
  for (let id = 1; id < next; id++)
    if (!seen.start.has(id)) gaps.push(`worker ${id} started past ace's worker factory`);
    else if (!seen.ack.has(id)) gaps.push(`worker ${id} never ran the hook`);
  return gaps;
}
