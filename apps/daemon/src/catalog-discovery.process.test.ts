import { expect, test } from "vitest";
import { mkdtemp, writeFile, chmod, rm, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discoverCodexExtensions } from "./catalog-discovery.ts";

test("cold discovery queries the fake app-server's paged skills, apps and MCP tools without starting a thread or sending input", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-catalog-probe-")));
  const binary = join(root, "codex.mjs"),
    log = join(root, "requests.jsonl");
  await writeFile(
    binary,
    `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(request) + '\\n');
  if (request.id === undefined) continue;
  let result = {};
  if (request.method === 'skills/list') result = { data: [{ cwd: process.cwd(), skills: [{ name: 'review', description: 'Project review', path: process.cwd() + '/.agents/skills/review/SKILL.md', scope: 'repo', enabled: true, unknown: { future: true } }, { name: 'disabled', description: '', path: '/scratch/disabled', scope: 'user', enabled: false }] }] };
  if (request.method === 'app/list') result = request.params.cursor ? { data: [{ id: 'calendar', name: 'Calendar', description: 'Read events', isAccessible: true, isEnabled: true }], nextCursor: null } : { data: [{ id: 'drive', name: 'Drive', description: 'Read docs', isAccessible: true, isEnabled: true }], nextCursor: 'next' };
  if (request.method === 'mcpServerStatus/list') result = { data: [{ name: 'docs', tools: { search: { name: 'search', description: 'Search docs' } } }] };
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
}
`,
  );
  await chmod(binary, 0o755);
  try {
    const entries = await discoverCodexExtensions({
      executable: binary,
      cwd: root,
      env: { HOME: root, CODEX_HOME: root },
      signal: new AbortController().signal,
    });
    expect(entries.find((e) => e.name === "review")).toMatchObject({
      source: { scope: "project" },
      invocation: { type: "skill", path: `${root}/.agents/skills/review/SKILL.md` },
    });
    expect(entries.filter((e) => e.invocation.type === "mention").map((e) => e.name)).toEqual([
      "Drive",
      "Calendar",
    ]);
    expect(entries.find((e) => e.name === "MCP: docs")).toMatchObject({
      kind: "plugin",
      invocation: { type: "unavailable" },
    });
    expect(entries.find((e) => e.name === "search")).toMatchObject({
      kind: "mcp-tool",
      invocation: { type: "tool", server: "docs", name: "search" },
    });
    const requests = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => z.object({ method: z.string() }).parse(JSON.parse(line)));
    expect(requests.map((r) => r.method)).toEqual([
      "initialize",
      "initialized",
      "skills/list",
      "app/list",
      "app/list",
      "mcpServerStatus/list",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
