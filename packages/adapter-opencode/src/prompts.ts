import { z } from "zod";
import type { ContentPart } from "@ace/protocol";
import type { OpenCodeClient } from "@opencode/client";
import type { Runtime } from "./runtime.ts";
import type { Observe } from "./observation.ts";
import { AdmissionQueue } from "./admission.ts";
import { object } from "./data.ts";
import { messageId, promptBody } from "./input.ts";
type Ports = {
  client: OpenCodeClient;
  runtime: Runtime;
  signal: AbortSignal;
  session(): string;
  directory(): string;
  frame: Observe;
  barrier(): Promise<void>;
  uncertain(): void;
};
/** Serializes HTTP admissions, leaving execution and durable inbox ownership independent. */
export class SessionPrompts {
  private ports: Ports;
  private admission = new AdmissionQueue();
  private sequence = 0;
  private started = false;
  private rejected = false;
  constructor(ports: Ports) {
    this.ports = ports;
  }
  observe(dir: string, channel: string, value: unknown): void {
    if (channel !== "http") return;
    const data = object(value);
    if (!String(data.path).endsWith("/prompt")) return;
    if (dir === "send") this.started = true;
    if (dir === "recv" && typeof data.status === "number" && data.status >= 400)
      this.rejected = true;
  }
  async send(input: ContentPart[], delivery: "steer" | "queue", commandId?: string): Promise<void> {
    if (commandId !== undefined) z.string().min(1).max(512).parse(commandId);
    const p = this.ports,
      release = await this.admission.acquire(p.signal);
    try {
      await p.barrier();
      this.started = this.rejected = false;
      const id = messageId(p.runtime.wallTime(), ++this.sequence, p.runtime.entropy(16));
      try {
        p.frame("note", "input.sending", { id, commandId });
        const reply = z
          .object({ id: z.literal(id), sessionID: z.literal(p.session()) })
          .passthrough()
          .parse(
            await p.client.session.prompt({
              sessionID: p.session(),
              ...promptBody(input, p.directory(), id),
              delivery,
            }),
          );
        p.frame("note", "input.accepted", reply);
      } catch {
        if (this.rejected || !this.started) {
          p.frame("note", "input.rejected", { id });
          throw new Error("OpenCode rejected input admission");
        }
        // A committed prompt may have lost its receipt. Never resubmit it automatically.
        p.frame("note", "input.uncertain", { id });
        p.uncertain();
        throw new Error(
          "OpenCode input acknowledgement uncertain; reconcile inbox before sending again",
        );
      }
    } finally {
      release();
    }
  }
}
