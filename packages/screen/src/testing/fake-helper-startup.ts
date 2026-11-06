import { connect } from "node:net";

const endpoint = process.argv.at(-1)?.replace(/^unix:/, "");
const socket = process.env.FAILURE_MODE === "socket" && endpoint ? connect(endpoint) : undefined;
const fail = () => {
  process.stderr.write(
    `${"Startup detail ".repeat(300)}\nScreenCast portal unavailable: org.freedesktop.portal.Desktop has no ScreenCast interface${socket ? "\n" : ""}`,
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
