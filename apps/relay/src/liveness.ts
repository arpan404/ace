import { WebSocket } from "ws";
import type { Clock } from "./clock.ts";

const noop = () => {};

/** Socket activity proves reachability; an open TCP handle alone does not. */
export function watchLiveness(socket: WebSocket, clock: Clock, idleMs: number, pingMs: number) {
  let stopped = false;
  let expire = noop;
  let probe = noop;
  const activity = () => {
    expire();
    expire = clock.schedule(idleMs, () => socket.terminate());
  };
  const ping = () => {
    if (stopped || socket.readyState !== WebSocket.OPEN) return;
    socket.ping();
    probe = clock.schedule(pingMs, ping);
  };
  const stop = () => {
    stopped = true;
    expire();
    probe();
    socket.off("message", activity);
    socket.off("ping", activity);
    socket.off("pong", activity);
  };
  socket.on("message", activity);
  socket.on("ping", activity);
  socket.on("pong", activity);
  socket.once("close", stop);
  activity();
  probe = clock.schedule(pingMs, ping);
  return stop;
}
