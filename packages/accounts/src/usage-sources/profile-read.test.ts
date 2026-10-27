import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { usageDeclaration } from "./builtin.ts";
import { readDeclaredUsage, type UsageAccount, type UsagePorts } from "./read.ts";

// Declared credential paths (`~/.gemini/...`, `data/opencode/...`) resolve inside Windows
// homes: drive letters, backslashes, and a home written with forward slashes.
const windows = process.platform === "win32";
const secret = "tok_live_3f9a8b7c6d5e4f3a2b1c";
const now = Date.parse("2026-10-15T12:00:00Z");
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ace-usage-profile-"));
  dirs.push(dir);
  return dir;
}
async function write(dir: string, parts: string[], value: unknown) {
  await mkdir(join(dir, ...parts.slice(0, -1)), { recursive: true });
  await writeFile(join(dir, ...parts), JSON.stringify(value));
}
function ports(respond: (url: string) => unknown) {
  const urls: string[] = [];
  const tokens: (string | null)[] = [];
  return {
    urls,
    tokens,
    ports: {
      readFile: (path) => readFile(path, "utf8"),
      readSqlite: async () => undefined,
      fetch: async (url: string, init: RequestInit) => {
        urls.push(url);
        tokens.push(new Headers(init.headers).get("authorization"));
        return Response.json(respond(url));
      },
      run: async () => {
        throw new Error("no command here");
      },
      inScratchDir: async (use) => use(await temp()),
      platform: "win32",
      now: () => now,
    } satisfies UsagePorts,
  };
}
const account = (homeDir: string, userHome: string): UsageAccount => ({
  homeDir,
  env: {},
  executable: "",
  userHome,
  soleAccount: true,
  baseEnv: {},
});

const geminiAnswer = (url: string) =>
  url.endsWith(":loadCodeAssist")
    ? { cloudaicompanionProject: "project-1", currentTier: { name: "Gemini Code Assist" } }
    : { buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 0.25 }] };

test.runIf(windows)(
  "Windows: Gemini CLI's login is read from the profile folder, however the home is spelled",
  async () => {
    const profile = join(await temp(), "Users", "person");
    await write(profile, [".gemini", "oauth_creds.json"], {
      access_token: secret,
      expiry_date: now + 60_000,
    });
    const declaration = usageDeclaration({ provider: "acp", acpAgentId: "official:gemini" });
    if (!declaration) throw new Error("no Gemini declaration");
    for (const userHome of [profile, profile.replaceAll("\\", "/")]) {
      const io = ports(geminiAnswer);
      const result = await readDeclaredUsage(
        declaration,
        account(profile, userHome),
        io.ports,
        AbortSignal.timeout(5000),
      );
      expect(result, userHome).toMatchObject({
        ok: true,
        reading: { usageWindows: { "gemini-2.5-pro": { usedPercent: expect.closeTo(75, 6) } } },
      });
      // The token went out only as the CLI's own bearer credential.
      expect(new Set(io.tokens)).toEqual(new Set([`Bearer ${secret}`]));
    }
  },
);

test.runIf(windows)(
  "Windows: OpenCode Go usage reads the key an ace-managed account home keeps",
  async () => {
    const home = join(await temp(), "ace", "account-homes", "opencode-work");
    await write(home, ["data", "opencode", "auth.json"], {
      "opencode-go": { type: "api", key: secret },
    });
    const declaration = usageDeclaration({ provider: "opencode" });
    if (!declaration) throw new Error("no OpenCode declaration");
    const io = ports(() => ({
      usage: { rolling: { percent: 40, resetsAt: "2026-10-15T15:00:00Z" } },
    }));
    const result = await readDeclaredUsage(
      declaration,
      account(home, home),
      io.ports,
      AbortSignal.timeout(5000),
    );
    expect(result).toMatchObject({
      ok: true,
      reading: { usageWindows: { five_hour: { usedPercent: 40 } } },
    });
    expect(io.urls).toEqual(["https://opencode.ai/zen/go/v1/usage"]);
    expect(io.tokens).toEqual([`Bearer ${secret}`]);
  },
);
