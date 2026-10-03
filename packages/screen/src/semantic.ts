import { parseUITree, parseUIFind } from "./ui-results.ts";
import {
  ScreenUIActResult,
  ScreenUIFindOptions,
  ScreenUIFindResult,
  ScreenUITreeOptions,
  ScreenUITreeResult,
  type ScreenTarget,
  type ScreenUIActOptions,
} from "@ace/protocol";
import type { Helper } from "./helper.ts";

function requireTree(helper: Helper): void {
  if (!helper.capabilities?.uiTree) throw new Error("UI tree not supported by helper");
}
export async function readTree(
  helper: Helper,
  target: ScreenTarget,
  allowlist: string[],
  options: unknown,
) {
  requireTree(helper);
  const caps = ScreenUITreeOptions.parse(options);
  const result = await helper.request({
    op: "ui.tree",
    target,
    allowlist,
    ...caps,
  });
  if (helper.capabilities?.platform === "windows") {
    const tree = parseUITree(result, caps.maxNodes, caps.maxDepth);
    return { ...ScreenUITreeResult.parse({nodes: tree.root ? [tree.root] : [], truncated: tree.truncated}), root: tree.root };
  }
  return { ...ScreenUITreeResult.parse(result), root: null };
}
export async function findElements(
  helper: Helper,
  target: ScreenTarget,
  allowlist: string[],
  options: unknown,
) {
  requireTree(helper);
  const caps = ScreenUIFindOptions.parse(options);
  const result = await helper.request({
    op: "ui.find",
    target,
    allowlist,
    ...caps,
  });
  return helper.capabilities?.platform === "windows"
    ? parseUIFind(result, caps.limit)
    : ScreenUIFindResult.parse(result);
}
export async function actOnElement(
  helper: Helper,
  target: ScreenTarget,
  allowlist: string[],
  action: ScreenUIActOptions,
) {
  requireTree(helper);
  return ScreenUIActResult.parse(
    await helper.request({ op: "ui.act", target, allowlist, ...action }),
  );
}
