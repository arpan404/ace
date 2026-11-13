import type { SpadeComputers } from "../spade/computers.ts";
import type { SocketContext, SocketService } from "./socket.ts";

type SpadeComputerSocket = Pick<SocketContext, "authorize" | "connected" | "send" | "tasks"> & {
  options: { spadeComputers?: Pick<SpadeComputers, "computer" | "drive"> | undefined };
};

/**
 * `spade.computer.get` and `spade.computer.drive`: a Spade bot's browser and screen use, and
 * who drives them. Spade asks for its `GET /v1/agents/{id}/computer` and sets the driver when the
 * person takes over or hands back. Both need operate.
 */
export function createSpadeComputerSession(context: SpadeComputerSocket): SocketService {
  return {
    handle(message) {
      if (message.type !== "spade.computer.get" && message.type !== "spade.computer.drive")
        return false;
      if (!context.connected()) return true;
      const computers = context.options.spadeComputers;
      const error = !context.authorize("operate")
        ? ("forbidden" as const)
        : !computers
          ? ("unavailable" as const)
          : undefined;
      const { requestId, bot } = message;
      if (message.type === "spade.computer.get") {
        context.send(
          error || !computers
            ? { type: "spade.computer.result", requestId, error: error ?? "unavailable" }
            : { type: "spade.computer.result", requestId, computer: computers.computer(bot) },
        );
        return true;
      }
      if (error || !computers) {
        context.send({
          type: "spade.computer.drive.result",
          requestId,
          error: error ?? "unavailable",
        });
        return true;
      }
      // Answered once the bot's calls in flight have stopped, without holding up the socket.
      const task = computers.drive(bot, message.driver).then((result) => {
        if (context.connected())
          context.send({ type: "spade.computer.drive.result", requestId, ...result });
      });
      context.tasks.add(task);
      void task.finally(() => context.tasks.delete(task));
      return true;
    },
  };
}
