import { checkRegistry } from "./check.ts";
import { loadFacts, loadRegistry, repoRoot } from "./registry.ts";

const usage = "Usage: bun run docs:connectors [check | --check]";

async function check(): Promise<number> {
  const problems = checkRegistry(await loadRegistry(repoRoot), await loadFacts(repoRoot));
  for (const problem of problems) console.error(problem);
  if (problems.length) return 1;
  console.log("Connector registrations agree with the code");
  return 0;
}

try {
  const [command, ...rest] = process.argv.slice(2);
  if ((command === "check" || command === "--check") && rest.length === 0)
    process.exitCode = await check();
  else {
    console.error(usage);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
