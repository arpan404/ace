import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { usageDeclaration } from "./builtin.ts";
import { readDeclaredUsage, type UsageAccount, type UsagePorts } from "./read.ts";

/*
 * cursor-agent on Windows keeps its login in `%APPDATA%\Cursor\auth.json` (falling back to
 * `~\AppData\Roaming` when APPDATA is unset), as its `cli-credentials` file store does.
 */
const secret = "tok_live_3f9a8b7c6d5e4f3a2b1c";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ace-cursor-usage-"));
  dirs.push(dir);
  return dir;
}
async function login(root: string) {
  await mkdir(join(root, "Cursor"), { recursive: true });
  await writeFile(join(root, "Cursor", "auth.json"), JSON.stringify({ accessToken: secret }));
}
const usage = {
  billingCycleEnd: "1792851573000",
  planUsage: { autoPercentUsed: 40, apiPercentUsed: 10, totalPercentUsed: 25 },
};
function windowsPorts() {
  const sent: RequestInit[] = [];
  const ports: UsagePorts = {
    readFile: (path) => readFile(path, "utf8"),
    readSqlite: async () => undefined,
    fetch: async (_url, init) => {
      sent.push(init);
      return Response.json(usage);
    },
    run: async () => JSON.stringify({ subscriptionTier: "Pro", userEmail: "me@x.dev" }),
    inScratchDir: async (use) => use(await temp()),
    platform: "win32",
    now: () => Date.parse("2026-10-15T12:00:00Z"),
  };
  return { ports, sent };
}
const account = (home: string, baseEnv: NodeJS.ProcessEnv): UsageAccount => ({
  homeDir: home,
  env: {},
  executable: "cursor-agent",
  userHome: home,
  signedInAs: "me@x.dev",
  soleAccount: false,
  baseEnv,
});
async function readCursor(who: UsageAccount, ports: UsagePorts) {
  const declaration = usageDeclaration({ provider: "cursor" });
  if (!declaration) throw new Error("no Cursor declaration");
  return readDeclaredUsage(declaration, who, ports, AbortSignal.timeout(5000));
}

test.runIf(process.platform === "win32").each([
  ["%APPDATA%", (home: string) => join(home, "Profile", "Roaming"), true],
  [
    "~\\AppData\\Roaming when APPDATA is unset",
    (home: string) => join(home, "AppData", "Roaming"),
    false,
  ],
] as const)("Cursor on Windows reads its login from %s", async (_name, root, setAppData) => {
  const home = await temp();
  await login(root(home));
  const io = windowsPorts();
  const result = await readCursor(
    account(home, setAppData ? { APPDATA: root(home) } : {}),
    io.ports,
  );
  expect(result).toMatchObject({
    ok: true,
    reading: { planType: "Pro", usageWindows: { included: { usedPercent: 25 } } },
  });
  expect(new Headers(io.sent[0]?.headers).get("authorization")).toBe(`Bearer ${secret}`);
});

test.runIf(process.platform === "win32")(
  "Cursor on Windows ignores the Linux login path",
  async () => {
    const home = await temp();
    await login(join(home, ".config"));
    const io = windowsPorts();
    const result = await readCursor(account(home, {}), io.ports);
    expect(result).toMatchObject({ ok: true, reading: { planType: "Pro" } });
    expect(result).not.toHaveProperty("reading.usageWindows");
    expect(io.sent).toEqual([]);
  },
);
