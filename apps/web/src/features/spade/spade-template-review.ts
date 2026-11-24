import type { ShareTemplateDraft, ShareTemplateReview } from "@ace/protocol/marketplace";

type Extra =
  | "knowledge"
  | "include_heartbeat"
  | "surfaces"
  | "contracts"
  | "plugins"
  | "event_routines";
export type TemplateEdits = Omit<ShareTemplateReview, "visibility" | "reviewed" | Extra> & {
  [Key in Extra]-?: NonNullable<ShareTemplateReview[Key]>;
};

export function reviewItems(draft: ShareTemplateDraft, edits: TemplateEdits) {
  const { recipe } = draft;
  const items: { key: string; label: string; text: string }[] = [];
  function add(label: string, value: unknown) {
    if (value === undefined) return;
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    items.push({ key: JSON.stringify([label, text]), label, text });
  }
  add("Name", edits.name);
  add("Description", edits.description);
  add("Task", edits.task);
  edits.notes.forEach((note, i) => add(`Note ${i + 1}`, note));
  edits.knowledge.forEach((page, i) => add(`Page ${i + 1} · ${page.title}`, page));
  edits.routines.forEach((routine, i) => add(`Routine ${i + 1} · ${routine.name}`, routine));
  for (const trigger of recipe.triggers) {
    if (
      (trigger.kind === "event" || trigger.kind === "webhook") &&
      edits.event_routines.includes(trigger.name)
    )
      add(`Event routine · ${trigger.name}`, trigger);
  }
  for (const skill of draft.skills.filter(({ reference }) => edits.skills.includes(reference))) {
    add(`${skill.reference} · SKILL.md`, skill.text);
    skill.files.forEach(({ path, text }) => add(`${skill.reference} · ${path}`, text));
  }
  for (const surface of recipe.surfaces ?? []) {
    if (!edits.surfaces.includes(surface.id)) continue;
    add(`Surface · ${surface.id}`, surface);
    const file = draft.surface_files.find(({ path }) => path === surface.file);
    if (file) add(`Surface · ${file.path}`, file.text);
  }
  for (const contract of recipe.contracts ?? []) {
    if (edits.contracts.includes(contract.name)) add(`Contract · ${contract.name}`, contract);
  }
  for (const need of recipe.needs.connectors) {
    if (edits.connectors.includes(need.id)) add(`App · ${need.id}`, need);
  }
  add("Personality", recipe.personality);
  if (Array.isArray(recipe.effects) && recipe.effects.length)
    add("Requested effects", recipe.effects);
  for (const plugin of edits.plugins) {
    const commands = recipe.plugin_commands?.[plugin];
    if (commands?.length) add(`Plugin commands · ${plugin}`, commands);
  }
  if (edits.include_heartbeat) add("Heartbeat", recipe.heartbeat);
  return items;
}
