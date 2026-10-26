import { main } from "./setup-system.ts";

// Never fails the installer: each step reports its own outcome.
await main(process.argv.slice(2), import.meta.dirname).catch((error: unknown) => {
  console.error(`[ace setup] ${error instanceof Error ? error.message : String(error)}`);
});
