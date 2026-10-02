import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createInstance, type MigrationSafety } from "./index.ts";
import { ProviderPayload } from "@ace/provider-kit/payload";

/** Encode trusted test fixtures through the same byte admission boundary as native transports. */
export function quotaPayload(value: unknown): ProviderPayload {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Fixture is not JSON");
  return new ProviderPayload(encoded);
}

export const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];
export const idle: MigrationSafety = { acquire: async () => ({ release: async () => {} }) };
const roots: string[] = [];
export async function temp() {
  const path = await mkdtemp(join(tmpdir(), "ace-accounts-"));
  roots.push(path);
  return path;
}
export async function cleanup() {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}
export async function put(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
  return path;
}
export async function hash(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
export async function homes(provider: "codex" | "claude" | "cursor" | "opencode") {
  const root = await temp();
  const from = createInstance({ id: "from", provider, label: "from", homeDir: join(root, "from") });
  const to = createInstance({ id: "to", provider, label: "to", homeDir: join(root, "to") });
  await mkdir(from.homeDir);
  await mkdir(to.homeDir);
  return { from, to, provider, nativeSessionId: ids[3] ?? "" };
}
export async function rollout(home: string, index: number, extra: Record<string, unknown> = {}) {
  const id = ids[index];
  if (!id) throw new Error("Invalid test id");
  return put(
    join(home, "sessions", "2026", "10", "02", `rollout-2026-10-02T10-00-00-${id}.jsonl`),
    `${JSON.stringify({ type: "session_meta", timestamp: "2026-10-02T10:00:00.000Z", payload: { id, session_id: id, timestamp: "2026-10-02T10:00:00.000Z", cwd: home, originator: "ace-test", cli_version: "0.159.1", source: "cli", model_provider: "openai", ...extra } })}\n${JSON.stringify({ type: "response_item", timestamp: "2026-10-02T10:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "synthetic history marker" }] } })}\n`,
  );
}
