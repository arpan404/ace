import type { SpadeComputers } from "../spade/computers.ts";
import type { SocketContext, SocketService } from "./socket.ts";

type SpadeComputerSocket = Pick<SocketContext, "authorize" | "connected" | "send"> & {
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
      context.send(
        error || !computers
          ? { type: "spade.computer.drive.result", requestId, error: error ?? "unavailable" }
          : {
              type: "spade.computer.drive.result",
              requestId,
              ...computers.drive(bot, message.driver),
            },
      );
      return true;
    },
  };
}
