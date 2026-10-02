import { networkInterfaces } from "node:os";
import { connect } from "node:net";

export function lanAddress(): string {
  const address = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry && !entry.internal && entry.family === "IPv4")?.address;
  if (!address)
    throw new Error("This network-isolation test requires a real external IPv4 interface");
  return address;
}
export function refusesTcp(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("Listener unexpectedly accepts LAN connections"));
    });
    socket.once("error", (error) => {
      if ("code" in error && error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
}
