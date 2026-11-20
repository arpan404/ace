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
 * skills) and Computer (what it has used and the services it keeps running). Each part is read
 * on its own; one that fails is null and says so, while the rest show. Pure but for `read`.
 */

/** Files and pages shown before the rest stay on the computer. */
const shown = 5;

export interface SpadeProfileRow {
  id: string;
  name: string;
  face: SpadeFaceRow;
  details: {
    task: string;
    model: string;
    machine: string;
    /** Null when they couldn't be read. */
    routines: { name: string; line: string; failed: boolean }[] | null;
  };
  library: {
    /** Spade's own Library starts with what every bot knows about the person; null for a bot. */
    about: string[] | null;
    notes: string[] | null;
    pages: { title: string; topic: string }[] | null;
    files: { name: string; folder: boolean; at: number | null }[] | null;
    skills: { name: string; word: string }[] | null;
  };
  computer: {
    /** What the computer is doing, or that it has never been used. */
    line: string;
    surfaces: { name: string; line: string | null; live: boolean }[];
    services: { name: string; words: string; running: boolean }[] | null;
  };
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

export async function spadeProfile(
  agent: SpadeAgent,
  machine: string,
  read: (path: string) => Promise<string>,
  now: number,
): Promise<SpadeProfileRow> {
  const base = `/v1/agents/${encodeURIComponent(agent.id)}`;
  const [routines, about, notes, pages, folder, store, services] = await Promise.all([
    part(() => read(`${base}/routines`), parseSpadeRoutines),
    agent.kind === "main" ? part(() => read("/v1/notes"), parseSpadeNotes) : null,
    part(() => read(`${base}/notes`), parseSpadeNotes),
    part(() => read(`${base}/knowledge`), parseSpadeKnowledge),
    part(() => read(`${base}/workspace?path=`), parseSpadeFolder),
    part(() => read("/v1/skills"), parseSpadeSkillStore),
    part(() => read(`${base}/services`), parseSpadeServices),
  ]);
  const used = spadeUsedSurfaces(agent.computer);
  return {
    id: agent.id,
    name: agent.name || "Untitled bot",
    face: botFace(agent),
    details: {
      task: agent.task,
      model: spadeModelWords(agent.model),
      machine,
      routines:
        routines?.map((routine) => {
          const said = spadeRoutineLine(routine, now);
          return { name: routine.name, line: said.text, failed: said.failed };
        }) ?? null,
    },
    library: {
      about: about?.filter((note) => !note.suggested).map((note) => note.text) ?? null,
      notes: notes?.filter((note) => !note.suggested).map((note) => note.text) ?? null,
      pages:
        pages?.slice(0, shown).map((page) => ({ title: page.title, topic: page.topic })) ?? null,
      files:
        folder?.entries
          .filter((entry) => entry.name !== spadeOwnFolder)
          .slice(0, shown)
          .map((entry) => ({
            name: entry.name,
            folder: entry.kind === "folder",
            at: entry.modifiedAt ?? null,
          })) ?? null,
      skills:
        store &&
        spadeSkillsOf(store, agent.id).map(({ skill, word }) => ({ name: skill.name, word })),
    },
    computer: {
      line: computerLine(agent, used.length),
      surfaces: used.map((kind) => {
        const surface = agent.computer?.surfaces.find((each) => each.kind === kind);
        return {
          name: spadeSurfaceNames[kind],
          line: (surface && spadeSurfaceLine(surface)) ?? null,
          live: surface?.live === true,
        };
      }),
      services:
        services?.map((service) => ({
          name: service.name,
          words: spadeServiceWords(service),
          running: service.state === "running",
        })) ?? null,
    },
  };
}
