import { mkdtemp, writeFile, mkdir, access, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { cursorAuthInHost, type SdkAuthBoundary } from "./index.ts";

it("isolates login stores, discards the return key and deletes only the selected credential file", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-auth-"));
  try {
    const a = join(root, "a", "user", ".cursor", "sdk");
    const b = join(root, "b", "user", ".cursor", "sdk");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    const file = join(a, "auth.json");
    const history = join(a, "checkpoints.ndjson");
    await writeFile(history, "preserved-checkpoint");
    await writeFile(join(b, "auth.json"), "other-instance-sentinel");
    const notices: string[] = [];
    const boundary: SdkAuthBoundary = {
      sdk: {
        Cursor: {
          auth: {
            async login(options) {
              options?.onLoginUrl?.("https://cursor.com/login?challenge=synthetic");
              await writeFile(file, "sentinel-api-key");
              return { apiKey: "sentinel-api-key", apiKeyExpiresAtMs: 9999 };
            },
            async logout() {
              await rm(file);
            },
            async status() {
              try {
                await access(file);
                return { status: "logged-in", backendUrl: "https://api.cursor.com" };
              } catch {
                return { status: "logged-out" };
              }
            },
          },
        },
      },
      environmentKeyPresent: () => false,
      credentialFileAbsent: async () => {
        try {
          await access(file);
          return false;
        } catch {
          return true;
        }
      },
      signal: new AbortController().signal,
      loginUrl: (url) => {
        notices.push(url);
      },
    };
    expect(await cursorAuthInHost("status", boundary)).toEqual({
      status: "logged-out",
      source: "none",
    });
    const loggedIn = await cursorAuthInHost("login", boundary);
    expect(loggedIn).toEqual({ status: "logged-in", source: "sdk-store" });
    expect(JSON.stringify(loggedIn)).not.toContain("sentinel-api-key");
    expect(notices).toEqual(["https://cursor.com/login?challenge=synthetic"]);
    expect(await cursorAuthInHost("logout", boundary)).toEqual({
      status: "logged-out",
      source: "none",
    });
    expect(await readFile(history, "utf8")).toBe("preserved-checkpoint");
    expect(await readFile(join(b, "auth.json"), "utf8")).toBe("other-instance-sentinel");
    expect(
      await cursorAuthInHost("status", { ...boundary, environmentKeyPresent: () => true }),
    ).toEqual({ status: "logged-in", source: "environment" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
