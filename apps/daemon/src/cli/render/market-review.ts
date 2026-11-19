import type { MarketReview, MarketReviewItem } from "@ace/protocol/marketplace";
import { findingSentence } from "@ace/marketplace/signer";

/*
 * An install's review as sentences (ADR 0178 §11), the same facts the app's review shows: what
 * it is, who published it, signed or not, ace's review mark, what it can run and reach, what the
 * device's scan found, what it needs and, for an update, what changed. Pure.
 */

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count === 1 ? "one" : count} ${count === 1 ? one : many}`;

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** What it runs and reaches, from its executions. */
function reach(items: readonly MarketReviewItem[]) {
  const runs: string[] = [];
  const reaches: string[] = [];
  const hooks: string[] = [];
  for (const item of items) {
    if (item.kind !== "execution") continue;
    const execution = item.execution;
    if (execution.kind === "stdio")
      runs.push(`${execution.name} (${[execution.command, ...execution.args].join(" ")})`);
    else if (execution.kind === "remote") reaches.push(host(execution.url));
    else hooks.push(`on ${execution.event} it runs ${execution.command}`);
  }
  return { runs, reaches: [...new Set(reaches)], hooks };
}

/** "It runs one MCP server and reaches api.linear.app." */
export function reachSentence(items: readonly MarketReviewItem[]): string | undefined {
  const { runs, reaches, hooks } = reach(items);
  const parts = [
    ...(runs.length ? [`runs ${plural(runs.length, "MCP server")}`] : []),
    ...(reaches.length ? [`reaches ${reaches.join(", ")}`] : []),
    ...(hooks.length ? [`has ${plural(hooks.length, "hook")}`] : []),
  ];
  if (parts.length === 0) return undefined;
  const last = parts.pop() ?? "";
  return `It ${parts.length ? `${parts.join(", ")} and ${last}` : last}.`;
}

const refOf = (review: MarketReview) => `${review.type}/${review.name} ${review.version}`;

/** The question a terminal asks before installing. */
export function installQuestion(review: MarketReview, items: readonly MarketReviewItem[]): string {
  const verb = review.updates
    ? `Update ${review.type}/${review.name} to ${review.version}`
    : `Install ${refOf(review)}`;
  const reaching = reachSentence(items);
  return `${verb}?${reaching ? ` ${reaching}` : ""}`;
}

function bodyLines(review: MarketReview): string[] {
  const body = review.body;
  switch (body.type) {
    case "suit":
      return [
        body.passes
          ? `A Suit with ${plural(body.files, "file")}${body.scenes.length ? `, scenes ${body.scenes.join(", ")}` : ""}${body.fonts.length ? `, fonts ${body.fonts.join(", ")}` : ""}.`
          : "This Suit fails ace's checks.",
        ...body.problems.map(
          (problem) => `  ${problem.path ? `${problem.path}: ` : ""}${problem.message}`,
        ),
      ];
    case "spade-skill":
      return [
        `A Spade skill, ${body.skillName}: ${body.description}`,
        `${plural(body.files, "file")}${body.flagged ? `, ${plural(body.flagged, "script or binary", "scripts or binaries")}` : ""}.`,
      ];
    case "spade-plugin":
      return [
        `A Spade plugin, ${body.pluginName}, with ${plural(body.executions, "thing it runs", "things it runs")}.`,
        ...(body.unsupported
          ? [`${plural(body.unsupported, "part")} ace doesn't run will be left out.`]
          : []),
      ];
    case "spade-bot":
      return [
        `A Spade bot, ${body.botName}, on the ${body.model} model: ${body.task}`,
        ...(body.routines.length
          ? [
              `Its routines (off until you start them): ${body.routines.map((routine) => `${routine.name} (${routine.schedule})`).join(", ")}.`,
            ]
          : []),
        ...(body.brings.length
          ? [
              `It brings ${body.brings.map((each) => `${each.type}/${each.name} ${each.version}`).join(", ")}.`,
            ]
          : []),
        ...body.needs.map(
          (need) => `It needs ${need.label}${need.required ? "" : " (optional)"}: ${need.why}`,
        ),
        ...(body.spadeReady ? [] : ["Spade isn't running, so the install waits for it."]),
        ...body.notes,
      ];
  }
}

/** The review, one fact a line. */
export function reviewLines(review: MarketReview, items: readonly MarketReviewItem[]): string[] {
  const lines = [`${refOf(review)}: ${review.title}`];
  const by = review.publisher
    ? `By @${review.publisher.name}`
    : review.from
      ? `From ${review.from}`
      : "From an unknown publisher";
  const mark = review.byAce
    ? "published by ace"
    : review.reviewed
      ? "reviewed by ace"
      : "not reviewed by ace";
  lines.push(`${by}. ${review.signed ? "Signed" : "Not signed"}, ${mark}.`);
  if (review.unlisted) lines.push("Unlisted: reached by its link, not by search.");
  lines.push(...bodyLines(review));
  const { runs, reaches, hooks } = reach(items);
  if (runs.length) lines.push(`It runs: ${runs.join("; ")}.`);
  if (reaches.length) lines.push(`It reaches: ${reaches.join(", ")}.`);
  for (const hook of hooks) lines.push(`${hook.charAt(0).toUpperCase()}${hook.slice(1)}.`);
  const findings = review.scan?.findings.filter((finding) => finding.level !== "note") ?? [];
  if (review.scan)
    lines.push(
      findings.length
        ? `The scan found ${plural(findings.length, "thing")} to know:`
        : "The scan found nothing to warn about.",
      ...findings.map(
        (finding) => `  ${finding.level === "block" ? "Blocks: " : ""}${findingSentence(finding)}`,
      ),
    );
  if (review.updates) {
    const changes = items.flatMap((item) => (item.kind === "change" ? [item] : []));
    lines.push(
      changes.length
        ? `What changed since ${review.updates}: ${changes.map((change) => `${change.change} ${change.path}`).join(", ")}.`
        : `Nothing in its files changed since ${review.updates}.`,
    );
  }
  for (const item of items) if (item.kind === "note") lines.push(item.text);
  if (review.deprecated) lines.push(`Deprecated: ${review.deprecated}`);
  if (review.blocked) lines.push(`It can't be installed: ${review.blocked}`);
  return lines;
}
