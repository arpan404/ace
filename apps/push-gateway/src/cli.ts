import { readGatewayConfig } from "./config.ts";
import { startGateway } from "./server.ts";

const gateway = await startGateway(readGatewayConfig(process.env));
console.log(JSON.stringify({ route: "start", port: gateway.port }));
let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  void gateway.close().catch(() => {
    process.exitCode = 1;
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
