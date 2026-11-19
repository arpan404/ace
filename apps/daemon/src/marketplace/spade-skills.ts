import type { MarketResult } from "@ace/protocol/marketplace";
import { marketError as error } from "./market-error.ts";
import { onForBots, type MarketStore } from "./store.ts";

/**
 * The market skills Spade may load: every installed `spade-skill` that is on and whose installed
 * version the person turned on for their bots (ADR 0178 §12.8). Spade drops a copy this stops
 * listing, so an unapproved update takes the skill from every bot until it is turned on.
 */
export function spadeSkills(store: MarketStore): MarketResult {
  return {
    op: "spadeSkills",
    skills: store
      .installs()
      .filter((install) => install.type === "spade-skill" && onForBots(install))
      .map((install) => ({
        name: install.name,
        version: install.version,
        hash: install.hash,
        description: install.description.slice(0, 1024),
      })),
  };
}

/** An installed market skill's file list, or one file's pinned bytes when `path` names it. */
export async function spadeSkillFiles(
  store: MarketStore,
  name: string,
  path: string | undefined,
): Promise<MarketResult> {
  const install = store.install("spade-skill", name);
  if (!install || !onForBots(install))
    return error("not_found", `There is no market skill ${name}`);
  const files = await store.pinned(install.hash, "spade-skill");
  const list = install.files.map((file) => ({
    path: file.path,
    bytes: file.bytes,
    hash: file.sha256,
    executable: file.executable,
  }));
  if (path === undefined) return { op: "spadeSkillFiles", files: list };
  const file = files.find((item) => item.path === path);
  if (!file) return error("not_found", `${name} has no file ${path}`);
  return {
    op: "spadeSkillFiles",
    files: list.filter((item) => item.path === path),
    content: Buffer.from(file.content).toString("base64"),
  };
}
