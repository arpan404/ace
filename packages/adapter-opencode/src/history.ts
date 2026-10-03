import { Page, ProjectedMessage } from "./boundaries.ts";
import { object, string } from "./data.ts";
/** Opaque pagination. Refresh the mutable head; stop at the previous immutable message. */
export class HistoryReader {
  private heads = new Map<string, string>();
  async read(
    id: string,
    list: (cursor?: string) => Promise<unknown>,
    receive: (message: unknown) => void,
  ): Promise<void> {
    const head = this.heads.get(id);
    let cursor: string | undefined,
      newest = "";
    const cursors = new Set<string>();
    for (let n = 0; n < 512; n++) {
      const page = Page.parse(await list(cursor));
      let reached = false;
      for (const message of page.data) {
        const key = string(object(message).id);
        if (!key) throw new Error("Invalid projected message identity");
        if (!newest) newest = key;
        receive(ProjectedMessage.parse(message));
        if (key === head) {
          reached = true;
          break;
        }
      }
      const next = page.cursor.next;
      if (!next || reached) {
        if (newest) this.heads.set(id, newest);
        return;
      }
      if (cursors.has(next)) throw new Error("Repeated OpenCode history cursor");
      cursors.add(next);
      cursor = next;
    }
    throw new Error("OpenCode history page limit reached");
  }
}
