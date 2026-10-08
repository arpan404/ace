import type { SocketContext, SocketService } from "./socket.ts";
export function createPromptFilesSession(context: SocketContext): SocketService {
  return {
    async handle(message) {
      if (message.type !== "prompts.request") return false;
      const allowed = () =>
        context.connected() &&
        context.authorize(message.operation.op === "write" ? "operate" : "read");
      if (!allowed()) {
        context.send({
          type: "prompts.result",
          requestId: message.requestId,
          result: {
            kind: "error",
            code: "forbidden",
            message: "This device isn't allowed to access these prompt files.",
          },
        });
        return true;
      }
      const files = context.options.promptFiles;
      const result = files
        ? await files.request(message.operation)
        : {
            kind: "error" as const,
            code: "unavailable" as const,
            message: "Prompt files aren't ready. Reconnect and try again.",
          };
      if (allowed()) context.send({ type: "prompts.result", requestId: message.requestId, result });
      return true;
    },
  };
}
