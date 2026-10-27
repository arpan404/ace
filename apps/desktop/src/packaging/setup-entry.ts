import { main } from "./setup-system.ts";

// Exit 2: agents are at work and nothing was stopped; the installer says so and quits.
// Any other failure never blocks the installer: each step reports its own outcome.
await main(process.argv.slice(2), import.meta.dirname).catch((error: unknown) => {
  console.error(`[ace setup] ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.name === "Refused") process.exitCode = 2;
});
