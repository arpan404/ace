/*
 * A plan waiting for review, said in one line for the strip above the composer: "Plan ready ·
 * Kill-all filters · 3 steps". The full plan opens on its own. Pure.
 */

export interface PlanReviewInput {
  title?: string | undefined;
  markdown: string;
  todos?: readonly unknown[] | undefined;
}

const numbered = /^\d+[.)]\s+\S/;
const bulleted = /^[-*+]\s+\S/;

/**
 * How many steps the plan has: its todo list when it has one, else the top-level items of its
 * first list kind (numbered first, then bullets) outside code blocks; zero when it has none.
 */
export function planReviewSteps(input: PlanReviewInput): number {
  if (input.todos?.length) return input.todos.length;
  let fenced = false;
  let numbers = 0;
  let bullets = 0;
  for (const line of input.markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    if (numbered.test(line)) numbers++;
    else if (bulleted.test(line)) bullets++;
  }
  return numbers || bullets;
}

/** "Plan ready · Kill-all filters · 3 steps"; the title or the count drops out when missing. */
export function planReviewLine(input: PlanReviewInput): string {
  const steps = planReviewSteps(input);
  const title = input.title?.trim();
  return [
    "Plan ready",
    title && title !== "Review the plan" ? title : undefined,
    steps ? `${steps} ${steps === 1 ? "step" : "steps"}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}
