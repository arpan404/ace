import { startRelay } from "./server.ts";
import { readRelayConfig } from "./config.ts";
const relay = await startRelay(readRelayConfig(process.env));
console.log(`ace relay listening on port ${relay.port}`);
let closing = false;
const shutdown = () => {
  if (!closing) {
    closing = true;
    void relay.close().catch(() => {
      process.exitCode = 1;
    });
  }
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
