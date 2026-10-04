import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveDaemonHome } from "@ace/service/home";
import { checkedSessionReference, SessionReference } from "./session-header.ts";
import { PiHistoryError } from "./history-errors.ts";

export function sessionReferenceDirectory(requested?: string): string {
  return (
    requested ?? join(resolveDaemonHome(homedir(), process.env.ACE_HOME), "pi-session-references")
  );
}
const compact = /^ace-pi-ref:([a-f0-9]{64})$/;
const key = (reference: SessionReference) =>
  createHash("sha256")
    .update(JSON.stringify(SessionReference.parse(reference)))
    .digest("hex");

/** Only paths and native IDs are persisted, never provider credentials or transcript data. */
export async function saveSessionReference(
  root: string,
  reference: SessionReference,
): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const hash = key(reference);
  const path = join(root, hash + ".json");
  const stage = await mkdtemp(join(root, ".publish-"));
  try {
    const temporary = join(stage, "reference.json");
    await writeFile(temporary, JSON.stringify(SessionReference.parse(reference)), { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return "ace-pi-ref:" + hash;
}
export async function loadSessionReference(
  root: string,
  value: string,
): Promise<SessionReference & { cwd: string }> {
  const match = compact.exec(value);
  if (!match) return checkedSessionReference(value);
  try {
    const file = await open(
      join(root, match[1] + ".json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let reference: SessionReference;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 65536) throw new PiHistoryError("header");
      const bytes = Buffer.alloc(65536);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      reference = SessionReference.parse(JSON.parse(bytes.toString("utf8", 0, bytesRead)));
    } finally {
      await file.close();
    }
    if (key(reference) !== match[1]) throw new PiHistoryError("identity");
    const saved = await checkedSessionReference(reference.path);
    if (saved.id !== reference.id) throw new PiHistoryError("identity");
    return saved;
  } catch (error) {
    if (error instanceof PiHistoryError) throw error;
    throw new PiHistoryError("missing");
  }
}
