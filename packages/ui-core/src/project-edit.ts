import type {
  BadgeColor,
  Project,
  ProjectBadgeStyle,
  ProjectDefaults,
  ProjectGlyph,
  ProjectNoteEdit,
  ProviderKind,
} from "@ace/protocol";
import { projectNameProblem } from "./projects.ts";

/*
 * Edit project, as every client saves it: the icon a person is choosing, the notes they typed,
 * and which `workspace.update` fields differ from what the project has. The web dialog and the
 * phone's Edit project screen both draw from these, so a save means the same everywhere.
 */

export type ProjectIconMode = "auto" | "initials" | "glyph" | "image";

/** The icon a person is choosing in the project editor. */
export interface ProjectIconChoice {
  mode: ProjectIconMode;
  /** Unset keeps the tint that stays with the project id. */
  color?: BadgeColor | undefined;
  glyph: ProjectGlyph;
  /** The custom image, once one is picked. */
  image?: string | undefined;
}

type IconSource = Pick<Project, "icon" | "badge"> | undefined;

/** What the project shows now, as a choice to start the editor from. */
export function projectIconChoice(project: IconSource): ProjectIconChoice {
  const badge = project?.badge;
  const image = project?.icon ?? undefined;
  return {
    mode: image ? "image" : badge?.glyph ? "glyph" : badge ? "initials" : "auto",
    color: badge?.color,
    glyph: badge?.glyph ?? "code",
    image,
  };
}

/** The badge an initials or glyph choice draws. */
export function projectBadgeStyle(choice: ProjectIconChoice): ProjectBadgeStyle {
  return {
    ...(choice.color ? { color: choice.color } : {}),
    ...(choice.mode === "glyph" ? { glyph: choice.glyph } : {}),
  };
}

/**
 * The `workspace.update` fields a choice saves. Image mode without a picked image changes
 * nothing; every other mode clears what it doesn't use.
 */
export function projectIconEdit(choice: ProjectIconChoice): {
  icon?: string | null;
  badge?: ProjectBadgeStyle | null;
} {
  switch (choice.mode) {
    case "auto":
      return { icon: null, badge: null };
    case "image":
      return choice.image ? { icon: choice.image, badge: null } : {};
    default:
      return { icon: null, badge: projectBadgeStyle(choice) };
  }
}

/** Notes as they are saved: trimmed, and a cleared one removed. */
export function projectNoteEdits(notes: readonly ProjectNoteEdit[]): ProjectNoteEdit[] {
  return notes.flatMap((note) => {
    const text = note.text.trim();
    if (!text) return [];
    return note.id ? [{ id: note.id, text }] : [{ text }];
  });
}

/** A project's notes as the editor starts from them. */
export function savedProjectNotes(project: Pick<Project, "notes"> | undefined): ProjectNoteEdit[] {
  return (project?.notes ?? []).map(({ id, text }) => ({ id, text }));
}

/** What the editor holds: the name always; the rest only once the person touched it. */
export interface ProjectEditDraft {
  name: string;
  icon?: ProjectIconChoice | undefined;
  defaults?: ProjectDefaults | undefined;
  notes?: readonly ProjectNoteEdit[] | undefined;
}

/** A project edit: its name, and the icon, defaults and notes fields to change. */
export interface ProjectEdit {
  name: string;
  icon?: string | null;
  badge?: ProjectBadgeStyle | null;
  defaults?: ProjectDefaults | null;
  notes?: ProjectNoteEdit[];
}

/** Whether two plain JSON values are equal, whatever order their keys were written in. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.entries(a).filter(([, value]) => value !== undefined);
  const right = new Map(Object.entries(b).filter(([, value]) => value !== undefined));
  return (
    left.length === right.size &&
    left.every(([key, value]) => right.has(key) && same(value, right.get(key)))
  );
}

export type ProjectEditResult =
  | { kind: "edit"; edit: ProjectEdit }
  | { kind: "unchanged" }
  | { kind: "invalid"; problem: string };

/**
 * What saving the draft sends: the name, plus each touched field that differs from the
 * project. Nothing different is `unchanged`, so the editor just closes.
 */
export function projectEdit(
  project: Pick<Project, "name" | "icon" | "badge" | "defaults" | "notes">,
  draft: ProjectEditDraft,
): ProjectEditResult {
  const name = draft.name.trim();
  const problem = projectNameProblem(name);
  if (problem) return { kind: "invalid", problem };
  const edit: ProjectEdit = { name };
  if (draft.icon) {
    const icon = projectIconEdit(draft.icon);
    const before = projectIconEdit(projectIconChoice(project));
    if (!same(icon, before)) Object.assign(edit, icon);
  }
  if (draft.defaults && !same(draft.defaults, project.defaults ?? {}))
    edit.defaults = draft.defaults;
  if (draft.notes) {
    const notes = projectNoteEdits(draft.notes);
    if (!same(notes, savedProjectNotes(project))) edit.notes = notes;
  }
  if (Object.keys(edit).length === 1 && name === project.name) return { kind: "unchanged" };
  return { kind: "edit", edit };
}

/** A model a project can default to. */
export interface ProjectDefaultModel {
  provider: ProviderKind;
  id: string;
  label: string;
}

/**
 * The models a project can default to: each provider's model once, whatever account serves it,
 * legacy ones left out. A saved default the catalog doesn't list right now stays offered rather
 * than silently lost.
 */
export function projectDefaultModels(
  models: readonly { provider: ProviderKind; id: string; label: string; legacy: boolean }[],
  current: Pick<ProjectDefaults, "provider" | "model">,
): ProjectDefaultModel[] {
  const seen = new Set<string>();
  const options: ProjectDefaultModel[] = [];
  const add = (provider: ProviderKind, id: string, label: string) => {
    const key = `${provider}\n${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    options.push({ provider, id, label });
  };
  for (const model of models) if (!model.legacy) add(model.provider, model.id, model.label);
  if (current.provider && current.model) add(current.provider, current.model, current.model);
  return options;
}

/** Which browser profile a project's threads open in, and what each choice means. */
export const projectBrowserProfiles = [
  { value: undefined, label: "Inherit", note: "Follows the machine's browser setting." },
  { value: "global", label: "Global", note: "Shares sign-ins with every project." },
  { value: "project", label: "This project", note: "Sign-ins stay in this project." },
  { value: "thread", label: "Each thread", note: "Each thread signs in on its own." },
] as const;
