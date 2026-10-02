import type { Frame } from "@ace/engine-api";
import { object, array, string } from "./data.ts";
import type { OpenCodeServer } from "./server.ts";
/** Page native history without retaining message bodies. Later reads stop at the prior head. */
export class HistoryReader {
  private heads = new Map<string, string>();
  private server: OpenCodeServer;
  private directory: string;
  private frame: (dir: Frame["dir"], channel: string, data: unknown) => void;
  private signal: AbortSignal;
  private receive: (data: unknown, started: number) => void;
  constructor(
    server: OpenCodeServer,
    directory: string,
    frame: HistoryReader["frame"],
    signal: AbortSignal,
    receive: HistoryReader["receive"],
  ) {
    this.server = server;
    this.directory = directory;
    this.frame = frame;
    this.signal = signal;
    this.receive = receive;
  }
  async read(id: string): Promise<void> {
    const head = this.heads.get(id);
    let before = "";
    let newest = "";
    const cursors = new Set<string>();
    while (!this.signal.aborted) {
      const query = new URLSearchParams({ limit: "128" });
      if (before) query.set("before", before);
      let count = 0;
      let oldest = "";
      let reachedHead = false;
      const started = this.server.eventWatermark;
      for await (const message of this.server.history(
        `/session/${id}/message?${query}`,
        this.directory,
        this.frame,
        this.signal,
      )) {
        const m = object(message);
        const msg = string(object(m.info).id);
        if (!msg) continue;
        count++;
        if (!oldest || msg < oldest) oldest = msg;
        if (!newest || msg > newest) newest = msg;
        if (head && msg <= head) reachedHead = true;
        this.receive(
          {
            payload: {
              type: "message.updated",
              properties: { sessionID: id, info: m.info, historical: true },
            },
          },
          started,
        );
        for (const part of array(m.parts))
          this.receive(
            {
              payload: { type: "message.part.updated", properties: { sessionID: id, part } },
            },
            started,
          );
      }
      if (count < 128 || reachedHead || !oldest || cursors.has(oldest)) break;
      cursors.add(oldest);
      before = oldest;
    }
    if (newest) this.heads.set(id, newest);
  }
}
