import type { Recipe } from "@ace/protocol/marketplace";

export function packageInstructions(recipe: Recipe): { label: string; text: string }[] {
  const sources = (recipe.knowledge ?? []).map((page, index) => ({
    label: `knowledge page ${index + 1}`,
    text: `${page.title}\n${page.body}`,
  }));
  if (recipe.heartbeat) sources.push({ label: "heartbeat", text: recipe.heartbeat.checklist });
  for (const trigger of recipe.triggers) {
    if (trigger.kind === "event" || trigger.kind === "webhook")
      sources.push({ label: `routine ${trigger.name}`, text: trigger.instruction });
  }
  return sources;
}
