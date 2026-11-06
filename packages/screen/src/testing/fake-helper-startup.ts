import { connect } from "node:net";

const endpoint = process.argv.at(-1)?.replace(/^unix:/, "");
const socket = process.env.FAILURE_MODE === "socket" && endpoint ? connect(endpoint) : undefined;
const diagnostic =
  process.env.SENSITIVE_STARTUP === "1"
    ? `ScreenCast portal unavailable: Bearer abcdefghijklmnopqrstuvwxyz at /srv/diagnostic-home/private/helper; secret ${process.env.SCREEN_STARTUP_SECRET}; inherited ${process.env.SCREEN_INHERITED_SECRET}`
    : "ScreenCast portal unavailable: org.freedesktop.portal.Desktop has no ScreenCast interface";
const fail = () => {
  process.stderr.write(
    `${"Startup detail ".repeat(300)}\n${diagnostic}${socket ? "\n" : ""}`,
    () => {
      if (socket) {
        process.stdin.resume();
        socket.end();
      } else process.exit(1);
    },
  );
};
if (socket) socket.once("connect", fail);
else fail();
