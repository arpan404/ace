import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readSession, writeSession } from "./session-file.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function dataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ace-session-file-"));
  roots.push(root);
  return root;
}
const session = (origin: string) => ({
  origin,
  token: "t".repeat(43),
  account: { id: "acct", email: "person@example.com", name: "Person" },
  expiresAt: 2_000_000_000_000,
  source: "login",
});

test("a session saved on ace's former backend address is still signed in, at the current one", async () => {
  const dir = await dataDir();
  await writeFile(
    join(dir, "ace-account.json"),
    JSON.stringify(session("https://relay.acehq.dev")),
  );
  const read = await readSession(dir);
  expect(read).toMatchObject({ origin: "https://cloud.acehq.dev", token: "t".repeat(43) });
  await writeSession(dir, read ?? null);
  expect(JSON.parse(await readFile(join(dir, "ace-account.json"), "utf8")).origin).toBe(
    "https://cloud.acehq.dev",
  );
});

test("a session on another backend keeps its origin", async () => {
  const dir = await dataDir();
  await writeFile(
    join(dir, "ace-account.json"),
    JSON.stringify(session("https://accounts.example")),
  );
  expect((await readSession(dir))?.origin).toBe("https://accounts.example");
});
