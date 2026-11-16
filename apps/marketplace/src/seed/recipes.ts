import { z } from "zod";

/*
 * Spade's built-in bot templates (spade/config/templates.json) as the market's first recipes
 * (ADR 0168 §9): each a version 2 bot file asking for nothing, with its listing words. Pure.
 */

const Template = z.object({
  id: z.string(),
  name: z.string(),
  blurb: z.string(),
  task: z.string(),
  face: z.record(z.string(), z.unknown()),
  model_kind: z.enum(["fast", "capable"]),
  routines: z.array(z.object({ name: z.string(), instruction: z.string(), schedule: z.string() })),
});
export const TemplatesFile = z.object({ templates: z.array(Template) });
export type Template = z.infer<typeof Template>;

/** Each template's categories and keywords, kept by hand. */
const listings: Readonly<Record<string, { categories: string[]; keywords: string[] }>> = {
  inbox: { categories: ["mail"], keywords: ["email", "inbox", "messages", "triage"] },
  research: { categories: ["research"], keywords: ["sources", "citations", "questions"] },
  "release-notes": {
    categories: ["engineering", "writing"],
    keywords: ["changelog", "releases", "pull requests"],
  },
  travel: { categories: ["travel", "planning"], keywords: ["trips", "flights", "itinerary"] },
  finance: { categories: ["money"], keywords: ["spending", "bills", "subscriptions", "budget"] },
  writing: { categories: ["writing"], keywords: ["drafts", "editing", "tone"] },
  "on-call": { categories: ["engineering"], keywords: ["alerts", "incidents", "errors"] },
  learning: { categories: ["learning"], keywords: ["study", "lessons", "quiz"] },
  "meeting-notes": { categories: ["meetings"], keywords: ["agenda", "follow-ups", "minutes"] },
  "health-habits": { categories: ["health"], keywords: ["habits", "routine", "check-in"] },
};

/** The recipe's `bot.json`: no secrets, no grants and no needs; its routines start paused. */
export function recipeOf(template: Template) {
  return {
    format: "spade-bot",
    version: 2,
    name: template.name,
    blurb: template.blurb,
    task: template.task,
    face: template.face,
    model: template.model_kind,
    routines: template.routines.map((routine) => ({
      name: routine.name,
      instruction: routine.instruction,
      schedule: routine.schedule,
    })),
  };
}

export function listingOf(template: Template) {
  const words = listings[template.id] ?? { categories: [], keywords: [] };
  return { line: template.blurb, ...words };
}
