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
  return ScreenUITreeResult.parse(
    await helper.request({
      op: "ui.tree",
      target,
      allowlist,
      ...ScreenUITreeOptions.parse(options),
    }),
  );
}
export async function findElements(
  helper: Helper,
  target: ScreenTarget,
  allowlist: string[],
  options: unknown,
) {
  requireTree(helper);
  return ScreenUIFindResult.parse(
    await helper.request({
      op: "ui.find",
      target,
      allowlist,
      ...ScreenUIFindOptions.parse(options),
    }),
  );
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
