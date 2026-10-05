import { z } from "zod";

const Decision = z.object({ id: z.string().max(256), allowed: z.boolean() });
/** Every native WebSocket handshake asks the daemon's current origin policy. */
export class WebSocketGate {
  private pending = new Map<string, { finish(allowed: boolean): void }>();
  private sequence = 0;
  request(
    url: string,
    emit: (method: string, params: unknown) => void,
    reply: (allowed: boolean) => void,
  ): void {
    try {
      const parsed = new URL(url);
      if (
        !["ws:", "wss:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        url.length > 8192 ||
        this.pending.size >= 32
      )
        return reply(false);
    } catch {
      return reply(false);
    }
    const id = String(++this.sequence);
    const finish = (allowed: boolean) => {
      clearTimeout(timer);
      this.pending.delete(id);
      reply(allowed);
    };
    const timer = setTimeout(() => finish(false), 10_000);
    this.pending.set(id, { finish });
    emit("ace.webSocketRequested", { id, url });
  }
  command(method: string, params: unknown): void {
    if (method !== "ace.webSocketDecision") return;
    const parsed = Decision.safeParse(params);
    if (parsed.success) this.pending.get(parsed.data.id)?.finish(parsed.data.allowed);
  }
  close(): void {
    for (const request of this.pending.values()) request.finish(false);
  }
}
