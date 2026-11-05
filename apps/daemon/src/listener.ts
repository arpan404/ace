import type { Server } from "node:http";
import type { Server as NetServer } from "node:net";

export const bindListener = (listener: NetServer, host: string, port: number) =>
  new Promise<number>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, host, () => {
      listener.removeListener("error", reject);
      const address = listener.address();
      if (!address || typeof address === "string") reject(new Error("Missing listener address"));
      else resolve(address.port);
    });
  });
export const closeListener = (listener: Server) =>
  new Promise<void>((resolve) => {
    listener.close(() => resolve());
    listener.closeAllConnections();
  });
