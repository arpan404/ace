import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createInstance, openRegistry, UsageSource, type UsageDeclaration } from "@ace/accounts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { refreshDeclaredLimits } from "./declared-limits.ts";

const now = Date.parse("2026-10-15T12:00:00Z");
const secret = "ya29.a0-never-leaves-the-read-7f3c";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const declaration: UsageDeclaration = {
  cli: "Example CLI",
  sources: [
    UsageSource.parse({
      kind: "token-http",
      file: "creds.json",
      token: ["access_token"],
      request: {
        method: "GET",
        url: "https://usage.example.com/quota",
        headers: { authorization: "Bearer {token}" },
      },
      mapping: {
        windows: [{ each: ["windows", "*"], amount: { path: ["used"], scale: "percent" } }],
      },
    }),
  ],
};

async function accounts() {
  const home = await mkdtemp(join(tmpdir(), "ace-declared-"));
  const registry = await openRegistry(join(home, "accounts.sqlite"));
  cleanups.push(async () => {
    registry.close();
    await rm(home, { recursive: true, force: true });
  });
  for (const id of ["works", "broken"]) {
    await mkdir(join(home, id));
    await writeFile(join(home, id, "creds.json"), JSON.stringify({ access_token: secret }));
    await registry.register(
      createInstance({ id, provider: "cursor", label: id, homeDir: join(home, id) }),
    );
    registry.ingest(id, {
      provider: "cursor",
      payload: new ProviderPayload(JSON.stringify({ auth: "logged_in" })),
      observedAt: now - 1,
      timeZone: "UTC",
    });
  }
  return { registry, home };
}

test("declared usage is recorded per account and its token never reaches a reading or an error", async () => {
  const { registry, home } = await accounts();
  const errors: string[] = [];
  let calls = 0;
  await refreshDeclaredLimits({
    registry,
    declaration: () => declaration,
    executable: () => undefined,
    env: {},
    now: () => now,
    signal: AbortSignal.timeout(5000),
    onError: (instance, message) => errors.push(`${instance}: ${message}`),
    ports: {
      readFile: (path) => readFile(path, "utf8"),
      fetch: async (_url, init) => {
        // One account's read works; the other's upstream fails and echoes what it was sent.
        if (++calls === 1) return Response.json({ windows: { daily: { used: 30 } } });
        return new Response(`denied ${new Headers(init.headers).get("authorization")}`, {
          status: 500,
        });
      },
      run: async () => "",
      now: () => now,
    },
  });
  const recorded = registry.list().map(({ instance, quota }) => [instance.id, quota.windows]);
  expect(recorded).toContainEqual([
    expect.any(String),
    { daily: expect.objectContaining({ usedPercent: 30 }) },
  ]);
  expect(errors).toEqual([expect.stringMatching(/: Example CLI usage is unavailable$/)]);
  // Nothing ace keeps or reports carries the credential.
  expect(JSON.stringify(registry.list())).not.toContain(secret);
  expect(JSON.stringify(errors)).not.toContain(secret);
  expect(await readFile(join(home, "accounts.sqlite"))).not.toContain(Buffer.from(secret));
});
