import type { TerminalAttachment } from "@ace/terminal";
import type { SocketContext, SocketService } from "./socket.ts";
interface Stream {
  attachment: TerminalAttachment;
  credit: (() => void) | undefined;
}
export function createTerminalSession({
  options,
  authorize,
  send,
  tasks,
  connected,
  canReadThread,
  sessionId,
}: SocketContext): SocketService {
  const streams = new Map<string, Stream>();
  const authStreams = new Map<string, string>();
  const stop = (id: string) => {
    const stream = streams.get(id);
    if (stream) {
      streams.delete(id);
      stream.attachment.detach();
      stream.credit?.();
    }
  };
  return {
    close() {
      for (const id of streams.keys()) stop(id);
    },
    handle(message) {
      if (message.type === "terminal.credit") {
        const stream = streams.get(message.subscriptionId);
        stream?.credit?.();
        if (stream) stream.credit = undefined;
        return true;
      }
      if (message.type !== "terminal.request") return false;
      const op = message.operation;
      if (op.op === "unsubscribe" && authStreams.has(op.subscriptionId)) {
        const terminalId = authStreams.get(op.subscriptionId);
        if (!authorize("accounts")) {
          send({
            type: "terminal.result",
            requestId: message.requestId,
            ok: false,
            error: "forbidden",
          });
          return true;
        }
        authStreams.delete(op.subscriptionId);
        const task = (async () => {
          if (terminalId) await options.accountManagement?.stop(terminalId, sessionId);
          send({ type: "terminal.result", requestId: message.requestId, ok: true });
        })().catch(() =>
          send({
            type: "terminal.result",
            requestId: message.requestId,
            ok: false,
            error: "terminal_failed",
          }),
        );
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
        return true;
      }
      if ("terminalId" in op && options.accountManagement?.owns(op.terminalId, sessionId)) {
        const auth = options.accountManagement;
        const reply = (ok: boolean, error?: string) =>
          send({
            type: "terminal.result",
            requestId: message.requestId,
            ok,
            ...(error ? { error } : {}),
          });
        if (!authorize("accounts")) {
          reply(false, "forbidden");
          return true;
        }
        const task = (async () => {
          if (op.op === "subscribe") {
            if (authStreams.size >= 8 || authStreams.has(op.subscriptionId))
              throw new Error("Auth subscription limit");
            authStreams.set(op.subscriptionId, op.terminalId);
            // Auth terminals have one live subscriber, no replay and no retained credit queue.
            reply(true);
            await auth.subscribe(op.terminalId, sessionId, (event) => {
              if (event.type === "exit") authStreams.delete(op.subscriptionId);
              if (connected() && authorize("accounts"))
                send({ type: "terminal.output", subscriptionId: op.subscriptionId, event });
              else void auth.stop(op.terminalId, sessionId).catch(() => {});
            });
          }
          if (op.op === "write") auth.write(op.terminalId, sessionId, op.data);
          if (op.op === "resize") auth.resize(op.terminalId, sessionId, op.cols, op.rows);
          if (op.op === "close") await auth.stop(op.terminalId, sessionId);
          if (op.op !== "subscribe") reply(true);
        })().catch(async () => {
          if (op.op === "subscribe") authStreams.delete(op.subscriptionId);
          await auth.stop(op.terminalId, sessionId).catch(() => {});
          if (connected()) reply(false, "terminal_failed");
        });
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
        return true;
      }
      if ("terminalId" in op && !op.threadId) {
        send({
          type: "terminal.result",
          requestId: message.requestId,
          ok: false,
          error: "forbidden",
        });
        return true;
      }
      const read = ["list", "subscribe", "unsubscribe"].includes(op.op);
      const scope = read ? "read" : "operate";
      const reply = (ok: boolean, error?: string) =>
        send({
          type: "terminal.result",
          requestId: message.requestId,
          ok,
          ...(error ? { error } : {}),
        });
      if (
        !authorize(scope) ||
        ("threadId" in op && (!op.threadId || !canReadThread(op.threadId)))
      ) {
        reply(false, "forbidden");
        return true;
      }
      const runtime = options.workspaceActions;
      if (!runtime) {
        reply(false, "terminal_unavailable");
        return true;
      }
      const task = (async () => {
        if (op.op === "unsubscribe") {
          stop(op.subscriptionId);
          reply(true);
          return;
        }
        if (op.op === "list") {
          send({
            type: "terminal.result",
            requestId: message.requestId,
            ok: true,
            terminals: runtime.listTerminals(op.threadId),
          });
          return;
        }
        if (op.op === "open") {
          const id = await runtime.openTerminal(op.threadId, op.name, op.cols, op.rows);
          send({
            type: "terminal.result",
            requestId: message.requestId,
            ok: true,
            terminal: runtime.describe(id, op.threadId),
          });
          return;
        }
        if (!op.threadId) throw new Error("Thread required");
        const terminal = runtime.terminal(op.terminalId, op.threadId);
        if (op.op === "write") terminal.write(op.data);
        if (op.op === "resize") terminal.resize(op.cols, op.rows);
        if (op.op === "close") await runtime.closeTerminal(op.terminalId, op.threadId);
        if (op.op !== "subscribe") {
          reply(true);
          return;
        }
        if (streams.size >= 8 || streams.has(op.subscriptionId)) {
          reply(false, "subscription_limit");
          return;
        }
        const stream: Stream = {
          attachment: terminal.attach({ fromOffset: op.fromOffset }),
          credit: undefined,
        };
        streams.set(op.subscriptionId, stream);
        reply(true);
        try {
          for await (const event of stream.attachment) {
            if (
              !connected() ||
              !authorize("read") ||
              !canReadThread(op.threadId) ||
              streams.get(op.subscriptionId) !== stream
            )
              break;
            const next = new Promise<void>((resolve) => {
              stream.credit = resolve;
            });
            send({ type: "terminal.output", subscriptionId: op.subscriptionId, event });
            if (event.type === "exit" || event.type === "resync") break;
            await next;
          }
        } finally {
          stop(op.subscriptionId);
        }
      })().catch(() => {
        if (connected()) reply(false, "terminal_failed");
      });
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
      return true;
    },
  };
}
