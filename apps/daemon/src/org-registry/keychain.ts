import { execFile } from "node:child_process";
import { z } from "zod";
import { decodeBase64url, encodeBase64url } from "@ace/account-grant";
import { marketSigningKey, type MarketSigningKey } from "@ace/marketplace";

/*
 * Where an organization's registry key lives (ADR 0206 §5.2): the keychain of the one machine its
 * owners chose, never a file, never ace's servers. The macOS Keychain through `security`, the
 * Secret Service through `secret-tool`; the secret goes in on standard input, never as an
 * argument another process could read. Tests pass `memoryKeychain`.
 */

/** The registry's keys on this machine: the one it signs with, and the one before a rotation. */
export interface RegistryKeys {
  current: MarketSigningKey;
  previous?: MarketSigningKey | undefined;
}

export interface RegistryKeychain {
  read(org: string): Promise<RegistryKeys | undefined>;
  write(org: string, keys: RegistryKeys): Promise<void>;
}

export class KeychainError extends Error {
  override name = "KeychainError";
}

const service = "dev.acehq.registry";
const Stored = z.object({
  current: z.object({ id: z.string(), seed: z.string() }),
  previous: z.object({ id: z.string(), seed: z.string() }).optional(),
});

const pack = (keys: RegistryKeys) =>
  encodeBase64url(
    new TextEncoder().encode(
      JSON.stringify({
        current: { id: keys.current.id, seed: encodeBase64url(keys.current.privateKey) },
        ...(keys.previous
          ? { previous: { id: keys.previous.id, seed: encodeBase64url(keys.previous.privateKey) } }
          : {}),
      }),
    ),
  );

function unpack(text: string): RegistryKeys {
  const stored = Stored.parse(JSON.parse(new TextDecoder().decode(decodeBase64url(text.trim()))));
  const key = (entry: { id: string; seed: string }) =>
    marketSigningKey(entry.id, decodeBase64url(entry.seed));
  return {
    current: key(stored.current),
    ...(stored.previous ? { previous: key(stored.previous) } : {}),
  };
}

/** Runs a keychain tool with `input` on standard input; its output, or why it failed. */
type Tool = (
  command: string,
  args: string[],
  input: string,
) => Promise<{ ok: boolean; out: string }>;

const runTool: Tool = (command, args, input) =>
  new Promise((resolve) => {
    const child = execFile(command, args, { timeout: 15_000, maxBuffer: 64 * 1024 }, (error, out) =>
      // The output may hold the key: it never reaches an error message.
      resolve({ ok: !error, out: String(out) }),
    );
    child.stdin?.end(input);
  });

/** This machine's keychain, or a refusal saying the platform has none ace can use yet. */
export function osKeychain(
  platform: NodeJS.Platform = process.platform,
  tool: Tool = runTool,
): RegistryKeychain {
  const unavailable = () =>
    new KeychainError(
      "This machine has no keychain ace can keep a registry key in yet (macOS and Linux with a Secret Service only).",
    );
  return {
    async read(org) {
      const found =
        platform === "darwin"
          ? await tool("security", ["find-generic-password", "-s", service, "-a", org, "-w"], "")
          : platform === "linux"
            ? await tool("secret-tool", ["lookup", "service", service, "org", org], "")
            : undefined;
      if (!found) throw unavailable();
      return found.ok && found.out.trim() ? unpack(found.out) : undefined;
    },
    async write(org, keys) {
      const secret = pack(keys);
      const stored =
        platform === "darwin"
          ? // `security -i` reads its command from standard input, so the secret is no argument.
            await tool(
              "security",
              ["-i"],
              `add-generic-password -U -s ${service} -a ${org} -w ${secret}\n`,
            )
          : platform === "linux"
            ? await tool(
                "secret-tool",
                ["store", "--label", `ace registry key (${org})`, "service", service, "org", org],
                secret,
              )
            : undefined;
      if (!stored) throw unavailable();
      if (!stored.ok) throw new KeychainError("The keychain didn't take the registry key.");
    },
  };
}

/** A keychain in memory, for tests. */
export function memoryKeychain(): RegistryKeychain {
  const kept = new Map<string, string>();
  return {
    read: async (org) => {
      const text = kept.get(org);
      return text ? unpack(text) : undefined;
    },
    write: async (org, keys) => {
      kept.set(org, pack(keys));
    },
  };
}
