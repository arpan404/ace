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
import type { HelperPort } from "./helper-session.ts";

function requireTree(helper: HelperPort): void {
  if (!helper.capabilities?.uiTree) throw new Error("Helper has no UI tree support");
}
export async function readTree(
  helper: HelperPort,
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
    return {
      ...ScreenUITreeResult.parse({
        nodes: tree.root ? [tree.root] : [],
        truncated: tree.truncated,
      }),
      root: tree.root,
    };
  }
  if (helper.capabilities?.platform.startsWith("linux")) {
    const tree = parseUITree(
      {
        root: result && typeof result === "object" && "tree" in result ? result.tree : null,
        truncated:
          result && typeof result === "object" && "truncated" in result ? result.truncated : false,
      },
      caps.maxNodes,
      caps.maxDepth,
    );
    return {
      ...ScreenUITreeResult.parse({
        nodes: tree.root ? [tree.root] : [],
        truncated: tree.truncated,
      }),
      root: tree.root,
    };
  }
  return { ...ScreenUITreeResult.parse(result), root: null };
}
export async function findElements(
  helper: HelperPort,
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
  helper: HelperPort,
  target: ScreenTarget,
  allowlist: string[],
  action: ScreenUIActOptions,
  beforeDispatch?: () => void,
) {
  requireTree(helper);
  return ScreenUIActResult.parse(
    await helper.request({ op: "ui.act", target, allowlist, ...action }, beforeDispatch),
  );
}
