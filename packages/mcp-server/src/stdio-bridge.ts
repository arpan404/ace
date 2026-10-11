import { createInterface } from "node:readline";
import { z } from "zod";
import type { Readable, Writable } from "node:stream";
import { outputGate, RpcWriter, SseParser } from "@ace/provider-kit/streams";
import { nodeScheduler, type Scheduler } from "./registry.ts";
import { AceMcpConnectionSchema, type AceMcpConnection } from "./injection.ts";
const Message = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string().max(256), z.number().finite()]).optional(),
    method: z.string().min(1).max(256),
  })
  .passthrough();
export type BridgeOptions = {
  connection: AceMcpConnection;
  input: Readable;
  output: Writable;
  signal: AbortSignal;
  fetch?: typeof fetch;
  scheduler?: Scheduler;
};
/** One supervised stdio child, bounded request admission and callback-plus-drain writes. */
export async function runStdioBridge(options: BridgeOptions): Promise<void> {
  const connection = AceMcpConnectionSchema.parse(options.connection);
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const writer = new RpcWriter(options.output, 8 * 1024 * 1024);
  const active = new Map<string | number, AbortController>();
  const tasks = new Set<Promise<void>>();
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    lifetime.abort();
    writer.close(error);
    options.input.destroy();
  };
  const gate = outputGate(64 * 1024, () => true, fail);
  const write = async (value: unknown, writeSignal = signal) => {
    const line = `${JSON.stringify(value)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > 256 * 1024) throw new Error("MCP bridge response exceeds budget");
    await writer.send(line, bytes, writeSignal);
  };
  // ACP stdio clients can receive unsolicited notifications even though the
  // legacy request forwarding is stateless. Use the current subscription channel.
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const notifications = new Client(
    { name: "ace-stdio", version: "1" },
    {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  let listening: Promise<void> | undefined;
  const listen = () =>
    (listening ??= (async () => {
      await notifications.connect(
        new StreamableHTTPClientTransport(new URL(connection.url), {
          requestInit: { headers: { Authorization: `Bearer ${connection.bearer}` } },
          ...(options.fetch ? { fetch: options.fetch } : {}),
        }),
      );
      notifications.setNotificationHandler("notifications/tools/list_changed", () =>
        write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }),
      );
      if (notifications.getServerCapabilities()?.tools?.listChanged)
        await notifications.listen({ toolsListChanged: true });
    })());
  const forward = async (line: string): Promise<void> => {
    const message = Message.parse(JSON.parse(line));
    if (message.method === "notifications/initialized" || message.method === "tools/list")
      await listen().catch(() => {});
    if (message.method === "notifications/cancelled") {
      const cancelled = z
        .object({ params: z.object({ requestId: z.union([z.string(), z.number()]) }) })
        .safeParse(message);
      if (cancelled.success) active.get(cancelled.data.params.requestId)?.abort();
    }
    const controller = new AbortController();
    if (message.id !== undefined) {
      if (active.has(message.id)) throw new Error("Duplicate MCP request ID");
      active.set(message.id, controller);
    }
    let timedOut = false;
    // Registry tools may run for five minutes. A bridge deadline settles only
    // this request, preserving the provider's connection for subsequent tools.
    const cancelTimer = (options.scheduler ?? nodeScheduler).after(330_000, () => {
      timedOut = true;
      controller.abort();
    });
    const requestSignal = AbortSignal.any([signal, controller.signal]);
    try {
      const response = await (options.fetch ?? fetch)(connection.url, {
        method: "POST",
        redirect: "error",
        signal: requestSignal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${connection.bearer}`,
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: line,
      });
      if (!response.ok) throw new Error("MCP loopback request failed");
      if (message.id === undefined || response.status === 202) {
        await response.body?.cancel();
        return;
      }
      if (!response.body) throw new Error("Empty MCP reply");
      const reader = response.body.getReader();
      let bytes = 0;
      let reply: unknown;
      const sse = response.headers.get("content-type")?.includes("text/event-stream");
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const body = sse ? undefined : Buffer.allocUnsafe(256 * 1024);
      const parser = new SseParser(
        (event) => {
          const value: unknown = JSON.parse(event.data);
          const envelope = z
            .object({ id: z.union([z.string(), z.number()]).optional() })
            .passthrough()
            .parse(value);
          if (envelope.id === message.id) reply = value;
        },
        "",
        { maxLineBytes: 256 * 1024, maxEventBytes: 256 * 1024 },
      );
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 256 * 1024) throw new Error("MCP reply budget exceeded");
          if (sse) {
            parser.feed(decoder.decode(part.value, { stream: true }));
            if (reply !== undefined) break;
          } else body?.set(part.value, bytes - part.value.byteLength);
        }
        if (sse) parser.feed(decoder.decode());
        else reply = JSON.parse(decoder.decode(body?.subarray(0, bytes)));
        if (reply === undefined) throw new Error("MCP reply did not settle request");
        const envelope = z
          .object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]) })
          .passthrough()
          .parse(reply);
        if (envelope.id !== message.id) throw new Error("MCP reply identity mismatch");
        cancelTimer();
        await write(reply, requestSignal);
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch {
      if (message.id !== undefined && !signal.aborted)
        await write({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32603,
            message: timedOut
              ? "ace MCP bridge request timed out"
              : "ace MCP bridge request failed",
          },
        });
    } finally {
      cancelTimer();
      if (message.id !== undefined) active.delete(message.id);
    }
  };
  const lines = createInterface({ input: options.input.pipe(gate), crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (signal.aborted) return;
    if (tasks.size >= 64) {
      fail(new Error("MCP bridge request capacity exceeded"));
      return;
    }
    const task = forward(line).catch((error) =>
      fail(error instanceof Error ? error : new Error("MCP bridge failed")),
    );
    tasks.add(task);
    void task.then(() => tasks.delete(task));
  });
  const abort = () => {
    lines.close();
    options.input.destroy();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    else await new Promise<void>((resolve) => lines.once("close", resolve));
    await Promise.all(tasks);
    lifetime.abort();
    if (failure) throw failure;
  } finally {
    signal.removeEventListener("abort", abort);
    await notifications.close();
    lines.close();
    gate.destroy();
    writer.close(new Error("MCP bridge closed"));
  }
}
