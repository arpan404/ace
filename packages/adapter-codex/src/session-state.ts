import { list, obj, str, type Obj } from "./native.ts";
export type ReadObservation = { started?: string; completed: Set<string> };

/** Item changes do not prove that a snapshot's active turn has settled or been superseded. */
export function recoveryUncertain(
  thread: Obj,
  revision: { read: number; current: number },
  observed: ReadObservation,
): boolean {
  if (revision.read === revision.current || observed.started) return false;
  const active = list(thread["turns"]).map(obj).filter((turn) => turn["status"] === "inProgress");
  return active.some((turn) => !observed.completed.has(str(turn["id"]))) ||
    (obj(thread["status"])["type"] === "active" && active.length === 0);
}
/** Parse native thread ancestry once, for control and discovery decisions. */
export function parentOf(thread: Obj): string {
  return str(
    thread["parentThreadId"],
    str(obj(obj(obj(thread["source"])["subAgent"])["thread_spawn"])["parent_thread_id"]),
  );
}
export function hydrateControls(
  thread: Obj,
  active: Map<string, string>,
  shells: Map<string, string>,
): void {
  const id = str(thread["id"]);
  for (const entry of list(thread["turns"])) {
    const turn = obj(entry);
    if (turn["status"] === "inProgress") active.set(id, str(turn["id"]));
    for (const value of list(turn["items"])) {
      const item = obj(value);
      if (item["type"] === "commandExecution" && item["status"] === "inProgress")
        shells.set(str(item["id"]), id);
    }
  }
}
