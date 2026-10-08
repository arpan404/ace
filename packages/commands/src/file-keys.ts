import { createHash } from "node:crypto";
import { sep } from "node:path";
import type { DiscoveryRoot } from "./roots.ts";
export type RegisteredRoot = DiscoveryRoot & { id: string };
export const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);
export const sourceId = (root: DiscoveryRoot, path: string) =>
  createHash("sha256")
    .update(
      `${root.instance ?? "library"}:${root.scope}:${root.format}:${root.kind ?? (root.skill ? "skill" : "command")}:${path}`,
    )
    .digest("hex")
    .slice(0, 24);
export const key = (root: RegisteredRoot, path: string) => `${root.id}:${path}`;
