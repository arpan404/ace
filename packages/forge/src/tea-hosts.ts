import type { ForgeKind } from "@ace/protocol/forge";

/** Gitea and Forgejo share one adapter through tea (ADR 0117). */
export function isTeaHost(forge: ForgeKind): forge is "gitea" | "forgejo" {
  return forge === "gitea" || forge === "forgejo";
}
