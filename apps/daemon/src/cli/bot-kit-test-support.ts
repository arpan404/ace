import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/*
 * A real `spade` on a throwaway data folder for the developer kit's process tests (ADR 0200 §9),
 * reached by its own address and token. It has its own HOME, no ace, no cloud and a model
 * endpoint nothing listens on: nothing reaches the network, a model, or the person's own Spade.
 * On macOS the HOME gets an empty keychain of its own, since Spade keeps endpoint keys in the
 * keychain and macOS has none for a fresh HOME; the person's keychains are never opened.
 */

export const spadeProgram = fileURLToPath(
  new URL("../../../../spade/target/debug/spade", import.meta.url),
);
export const canRunSpade = existsSync(spadeProgram) || process.env.CI === "true";

export type SpadeApi = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: unknown }>;

export interface ThrowawaySpade {
  readonly data: string;
  readonly home: string;
  readonly api: SpadeApi;
  stop(): void;
}

const run = promisify(execFile);

/** Starts Spade under `root` (`root/home`, `root/spade`), with a model for new bots. */
export async function startThrowawaySpade(root: string): Promise<ThrowawaySpade> {
  const home = join(root, "home");
  const data = join(root, "spade");
  await mkdir(home, { recursive: true });
  if (process.platform === "darwin") {
    const keychains = join(home, "Library", "Keychains");
    await mkdir(keychains, { recursive: true });
    await run("security", ["create-keychain", "-p", "", join(keychains, "login.keychain-db")], {
      env: { PATH: process.env.PATH ?? "", HOME: home },
    });
  }
  const child: ChildProcess = spawn(spadeProgram, [], {
    // No session bus on Linux: Spade finds no keychain and never touches the person's.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      SPADE_DATA_DIR: data,
      SPADE_LISTEN: "127.0.0.1:0",
      SPADE_SANDBOX: "off",
      SPADE_CLOUD_URL: "off",
      RUST_LOG: "warn",
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 20_000;
  while (!existsSync(join(data, "server.json"))) {
    if (Date.now() > deadline) throw new Error("Spade didn't start");
    await new Promise((done) => setTimeout(done, 50));
  }
  const address = JSON.parse(await readFile(join(data, "server.json"), "utf8")).address;
  const token = (await readFile(join(data, "token"), "utf8")).trim();
  const api: SpadeApi = async (method, path, body) => {
    const response = await fetch(`http://${address}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  const ok = async (method: string, path: string, body: unknown) => {
    const answer = await api(method, path, body);
    if (answer.status >= 300)
      throw new Error(`${method} ${path}: ${answer.status} ${JSON.stringify(answer.body)}`);
  };
  // A model for new bots, on an address nothing listens on.
  await ok("POST", "/v1/endpoints", {
    name: "Unreached",
    format: "openai-chat",
    base_url: "http://127.0.0.1:9/v1/",
  });
  await ok("POST", "/v1/endpoints/unreached/models", { id: "m", name: "M" });
  await ok("PUT", "/v1/settings", { new_bot_model: "unreached/m", fast_model: "unreached/m" });
  return { data, home, api, stop: () => void child.kill("SIGTERM") };
}
