import { z } from "zod";
import { PreviewDescriptor } from "@ace/protocol/preview";
import type { ThreadId, AgentControlResult } from "@ace/protocol";

const OwnedPreviewDescriptor = PreviewDescriptor.extend({
  name: z.string().min(1).max(128).optional(),
  origin: z.url().max(2048).optional(),
});

/** Only host-owned previews can be registered. No tool can claim an arbitrary port. */
export class AgentPreviews {
  private entries = new Map<
    string,
    {
      threadId: ThreadId;
      descriptor: z.infer<typeof PreviewDescriptor>;
      close(): Promise<void>;
      closing?: Promise<void>;
    }
  >();
  register(id: string, threadId: ThreadId, descriptor: unknown, close: () => Promise<void>) {
    z.string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_.-]+$/)
      .parse(id);
    if (this.entries.has(id) || this.entries.size >= 64)
      throw new Error("Preview capacity or duplicate id");
    // Bound descriptors before retaining host data or returning it through MCP.
    const bounded = OwnedPreviewDescriptor.parse(descriptor);
    if (Buffer.byteLength(JSON.stringify(bounded)) > 3072)
      throw new Error("Preview descriptor byte budget");
    const entry = { threadId, descriptor: bounded, close };
    this.entries.set(id, entry);
    return () => {
      if (this.entries.get(id) === entry) this.entries.delete(id);
    };
  }
  list(threadId: ThreadId) {
    return [...this.entries].flatMap(([id, entry]) =>
      entry.threadId === threadId ? [{ id, descriptor: entry.descriptor }] : [],
    );
  }
  async close(threadId: ThreadId, id: string): Promise<AgentControlResult> {
    const entry = this.entries.get(id);
    if (!entry || entry.threadId !== threadId) return { ok: false, code: "forbidden" };
    entry.closing ??= Promise.resolve()
      .then(() => entry.close())
      .then(() => {
        if (this.entries.get(id) === entry) this.entries.delete(id);
      })
      .catch((error: unknown) => {
        delete entry.closing;
        throw error;
      });
    await entry.closing;
    return { ok: true };
  }
}
