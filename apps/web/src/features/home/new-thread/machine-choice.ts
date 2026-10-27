import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { createContext, use } from "react";
import { z } from "zod";
import type { Machine } from "@/lib/machines.ts";

/*
 * Which machine New thread starts on (ADR 0102). A draft names its machine by the host id in its
 * key (`newThreadDraftKey`), so reopening a draft reopens its machine. Bare ⌘N opens the machine
 * started on last while it is online, and each machine remembers its own last project.
 */

const Remembered = z.object({
  machine: z.string().min(1).optional().catch(undefined),
  projects: z.record(z.string(), z.string().min(1)).catch({}),
});
type Remembered = z.infer<typeof Remembered>;

const storageKey = "ace.home.newThreadMachine";
const read = (storage: KeyValueStorage | undefined): Remembered =>
  readJson(storage, storageKey, Remembered, { projects: {} });

/** The machine New thread opened on last, by host id; undefined for this window's own. */
export function rememberedMachine(storage: KeyValueStorage | undefined): string | undefined {
  return read(storage).machine;
}

/** The project New thread used last on `host`. */
export function rememberedProject(
  storage: KeyValueStorage | undefined,
  host: string,
): string | undefined {
  return read(storage).projects[host];
}

/** Remember `host` (undefined: this window's own) and, when given, its project. */
export function rememberMachine(
  storage: KeyValueStorage | undefined,
  machine: string | undefined,
  project?: { host: string; id: string },
): void {
  const { projects } = read(storage);
  writeJson(storage, storageKey, {
    ...(machine ? { machine } : {}),
    projects: project ? { ...projects, [project.host]: project.id } : projects,
  });
}

/**
 * The machine `?machine=` asks for; else this window's own when a project is named (a project
 * id belongs to one machine); else the one remembered, while it is online.
 */
export function targetMachine(
  search: { machine?: string | undefined; project?: string | undefined },
  machines: readonly Machine[],
  remembered: string | undefined,
): string | undefined {
  if (search.machine) return search.machine;
  if (search.project || !remembered) return undefined;
  const machine = machines.find((each) => each.id === remembered);
  return machine && !machine.primary && machine.status === "online" ? machine.id : undefined;
}

/** The machines New thread can start on, the one it starts on, and how to pick another. */
export interface NewThreadMachines {
  machines: readonly Machine[];
  current: Machine;
  /** Move New thread to `machine`, taking the project and the message along. */
  choose(machine: Machine, leaving?: Leaving): void;
}

/** What New thread takes along to another machine. */
export interface Leaving {
  /** The project: that machine's own copy, `chatChoice` for a chat, or the one to copy there. */
  project: string;
  /** The machine `project` is on, when that machine doesn't have it: sending copies it. */
  from?: string | undefined;
  /** The draft whose message goes along. */
  draft: { host: string; key: string };
}

export const NewThreadMachineContext = createContext<NewThreadMachines | undefined>(undefined);

export function useNewThreadMachines(): NewThreadMachines | undefined {
  return use(NewThreadMachineContext);
}
