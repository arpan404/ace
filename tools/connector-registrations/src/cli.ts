import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { artefacts } from "./artefacts.ts";
import { checkGenerated, checkRegistry } from "./check.ts";
import { loadFacts, loadRegistry, paths, readDoc, repoRoot } from "./registry.ts";
import { renderMarkdown } from "./render.ts";
import { runSlack } from "./slack.ts";

const usage = "Usage: bun run docs:connectors [render | check | --check | slack --yes]";

async function render(): Promise<number> {
  const files = artefacts(await loadRegistry(repoRoot));
  for (const [path, content] of files) {
    await mkdir(dirname(join(repoRoot, path)), { recursive: true });
    await writeFile(join(repoRoot, path), content);
  }
  console.log(`Wrote ${files.size} files: ${paths.doc} and ${paths.out}/`);
  return 0;
}

async function check(): Promise<number> {
  const registry = await loadRegistry(repoRoot);
  const problems = [
    ...checkRegistry(registry, await loadFacts(repoRoot)),
    ...checkGenerated(paths.doc, renderMarkdown(registry), await readDoc(repoRoot)),
  ];
  for (const problem of problems) console.error(problem);
  if (problems.length) return 1;
  console.log("Connector registrations agree with the code");
  return 0;
}

try {
  const [command = "render", ...rest] = process.argv.slice(2);
  if (command === "render" && rest.length === 0) process.exitCode = await render();
  else if ((command === "check" || command === "--check") && rest.length === 0)
    process.exitCode = await check();
  else if (command === "slack")
    process.exitCode = await runSlack({
      registry: await loadRegistry(repoRoot),
      args: rest,
      token: process.env.SLACK_CONFIG_TOKEN,
      isTTY: process.stdout.isTTY === true,
      fetch: (url, init) => fetch(url, init),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    });
  else {
    console.error(usage);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
