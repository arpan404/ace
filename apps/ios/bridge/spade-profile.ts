import { modelLabel } from "@ace/ui-core/providers";
import {
  parseSpadeFolder,
  parseSpadeKnowledge,
  parseSpadeNotes,
  parseSpadeRoutines,
  parseSpadeServices,
  parseSpadeSkillStore,
  spadeOwnFolder,
  spadeRoutineLine,
  spadeServiceWords,
  spadeSkillsOf,
  spadeSurfaceLine,
  spadeSurfaceNames,
  spadeUsedSurfaces,
  splitSpadeModel,
  type SpadeAgent,
} from "@ace/ui-core/spade-chat";
import { botFace, type SpadeFaceRow } from "./spade-group-rows.ts";

/*
 * A bot's profile on the iPhone (docs/design/spade.md §4), as a sheet: Details (its task, the
 * model and machine it runs with, its routines), Library (what it keeps: notes, pages, files,
 * skills) and Computer (what it has used and the services it keeps running). Each list is read
 * on its own; one that fails says so (`{failed: true}`) while the rest show, and one that doesn't
 * apply to this bot is null. Pure but for `read`.
 *
 * Every list is a preview, a few items long with each line clipped, and says how many more stay
 * on the computer. The whole reply is then held to a UTF-8 byte budget, dropping the last item
 * of the longest list until it fits: it travels in one of the pump's 32 KiB frames however much
 * the bot keeps, so it never holds back a live reply or an approval behind it (ADR 0074).
 */

/** Items each list shows before the rest stay on the computer. */
export const spadeProfileShown = {
  notes: 12,
  pages: 5,
  files: 5,
  skills: 8,
  routines: 10,
  services: 8,
};
/** The longest line a preview carries; the task is sent whole, since it is edited. */
const lineMax = 280;

/** A list as the sheet shows it: its first items and how many more there are, or that it failed. */
export type SpadeProfilePart<T> = { items: T[]; more: number } | { failed: true };

export interface SpadeProfileRow {
  id: string;
  name: string;
  face: SpadeFaceRow;
  details: {
    task: string;
    model: string;
    machine: string;
    routines: SpadeProfilePart<{ name: string; line: string; failed: boolean }>;
  };
  library: {
    /** Spade's own Library starts with what every bot knows about the person; absent for a bot. */
    about?: SpadeProfilePart<string>;
    notes: SpadeProfilePart<string>;
    pages: SpadeProfilePart<{ title: string; topic: string }>;
    files: SpadeProfilePart<{ name: string; folder: boolean; at: number | null }>;
    skills: SpadeProfilePart<{ name: string; word: string }>;
  };
  computer: {
    /** What the computer is doing, or that it has never been used. */
    line: string;
    surfaces: { name: string; line: string | null; live: boolean }[];
    services: SpadeProfilePart<{ name: string; words: string; running: boolean }>;
  };
}

/** A line cut to the preview's length, on a character boundary. */
const clip = (text: string) => {
  const chars = Array.from(text);
  return chars.length <= lineMax ? text : `${chars.slice(0, lineMax - 1).join("")}…`;
};

/** The first `max` of `items`, shaped, and how many were left out; `failed` when unread. */
function preview<T, R>(items: readonly T[] | null, max: number, shape: (item: T) => R) {
  if (!items) return { failed: true } as const;
  return { items: items.slice(0, max).map(shape), more: Math.max(0, items.length - max) };
}

/** A model reference in the words a person knows it by: `Claude Sonnet 4.5`. */
export function spadeModelWords(ref: string): string {
  if (!ref) return "Spade's default";
  const { model } = splitSpadeModel(ref);
  return modelLabel(model || ref);
}

function computerLine(agent: SpadeAgent, used: number): string {
  const computer = agent.computer;
  if (computer?.state === "starting") return "Waking up…";
  if (computer?.driver === "person") return "You have the controls";
  if (computer?.surfaces.some((surface) => surface.live)) return `${agent.name} is using it now`;
  return used ? "Asleep until it's needed" : `${agent.name} hasn't used its computer yet`;
}

/** Reads one part: its value, or null when the read or its parse failed. */
async function part<T>(read: () => Promise<string>, parse: (body: string) => T | undefined) {
  try {
    return parse(await read()) ?? null;
  } catch {
    return null;
  }
}

/** What the profile may weigh in UTF-8, leaving the rest of a 32 KiB frame for its envelope. */
export const spadeProfileBudget = 30_000;

/** A string's length in UTF-8 bytes, by its code points. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Drops the last item of the longest list, counting it in `more`, until the profile fits. */
function fit(profile: SpadeProfileRow): SpadeProfileRow {
  const parts: { items: unknown[]; more: number }[] = [
    profile.details.routines,
    profile.library.about,
    profile.library.notes,
    profile.library.pages,
    profile.library.files,
    profile.library.skills,
    profile.computer.services,
  ].flatMap((each) => (each && "items" in each ? [each] : []));
  while (utf8Bytes(JSON.stringify(profile)) > spadeProfileBudget) {
    const longest = parts.reduce<(typeof parts)[number] | undefined>(
      (most, each) => (each.items.length > (most?.items.length ?? 0) ? each : most),
      undefined,
    );
    if (!longest) break;
    longest.items.pop();
    longest.more++;
  }
  return profile;
}

export async function spadeProfile(
  agent: SpadeAgent,
  machine: string,
  read: (path: string) => Promise<string>,
  now: number,
): Promise<SpadeProfileRow> {
  const base = `/v1/agents/${encodeURIComponent(agent.id)}`;
  const main = agent.kind === "main";
  const [routines, about, notes, pages, folder, store, services] = await Promise.all([
    part(() => read(`${base}/routines`), parseSpadeRoutines),
    main ? part(() => read("/v1/notes"), parseSpadeNotes) : null,
    part(() => read(`${base}/notes`), parseSpadeNotes),
    part(() => read(`${base}/knowledge`), parseSpadeKnowledge),
    part(() => read(`${base}/workspace?path=`), parseSpadeFolder),
    part(() => read("/v1/skills"), parseSpadeSkillStore),
    part(() => read(`${base}/services`), parseSpadeServices),
  ]);
  const kept = (list: typeof notes) => list?.filter((note) => !note.suggested) ?? null;
  const shown = spadeProfileShown;
  const used = spadeUsedSurfaces(agent.computer);
  return fit({
    id: agent.id,
    name: agent.name || "Untitled bot",
    face: botFace(agent),
    details: {
      task: agent.task,
      model: spadeModelWords(agent.model),
      machine,
      routines: preview(routines, shown.routines, (routine) => {
        const said = spadeRoutineLine(routine, now);
        return { name: clip(routine.name), line: clip(said.text), failed: said.failed };
      }),
    },
    library: {
      ...(main ? { about: preview(kept(about), shown.notes, (note) => clip(note.text)) } : {}),
      notes: preview(kept(notes), shown.notes, (note) => clip(note.text)),
      pages: preview(pages, shown.pages, (page) => ({
        title: clip(page.title),
        topic: clip(page.topic),
      })),
      files: preview(
        folder?.entries.filter((entry) => entry.name !== spadeOwnFolder) ?? null,
        shown.files,
        (entry) => ({
          name: clip(entry.name),
          folder: entry.kind === "folder",
          at: entry.modifiedAt ?? null,
        }),
      ),
      skills: preview(store && spadeSkillsOf(store, agent.id), shown.skills, ({ skill, word }) => ({
        name: clip(skill.name),
        word,
      })),
    },
    computer: {
      line: computerLine(agent, used.length),
      surfaces: used.map((kind) => {
        const surface = agent.computer?.surfaces.find((each) => each.kind === kind);
        const line = surface && spadeSurfaceLine(surface);
        return {
          name: spadeSurfaceNames[kind],
          line: line ? clip(line) : null,
          live: surface?.live === true,
        };
      }),
      services: preview(services, shown.services, (service) => ({
        name: clip(service.name),
        words: spadeServiceWords(service),
        running: service.state === "running",
      })),
    },
  });
}
