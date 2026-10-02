import { list, obj, str, type Obj } from "./native.ts";
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
