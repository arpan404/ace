import { describe, expect, it } from "vitest";
import type { ForgeStackWorkspace } from "@ace/protocol";
import { stackConfirmation, stackConfirmationText, stackControls } from "./pr-stack-controls.ts";

const sha = (digit: string) => digit.repeat(40);
const layer = (number: number, position: number, state = "OPEN") => ({
  number,
  position,
  title: `Layer ${position}`,
  url: `https://github.com/acme/ace/pull/${number}`,
  headSha: sha(String(position)),
  branch: `stack/${position}`,
  baseBranch: position === 1 ? "main" : `stack/${position - 1}`,
  state,
  mergeState: "CLEAN",
  reviewDecision: "APPROVED",
  checksState: "SUCCESS",
  requiredChecks: [],
  checksTruncated: false,
  queueState: null,
});
const workspace = (patch: Partial<ForgeStackWorkspace> = {}): ForgeStackWorkspace => ({
  stack: {
    id: "stack-1",
    number: 3,
    trunk: "main",
    layers: [layer(10, 1), layer(11, 2), layer(12, 3)],
    canMerge: true,
    raw: {},
  },
  local: null,
  localUnavailable: null,
  operation: null,
  movedLayers: [],
  ...patch,
});

describe("a pull request's stack controls", () => {
  it("merges the layers up to this pull request once a linked thread runs it", () => {
    const controls = stackControls({
      workspace: workspace(),
      number: 11,
      associated: true,
      busy: false,
    });
    expect(controls[0]).toEqual({ action: "merge", label: "Merge through #11", reason: undefined });
    const confirmation = stackConfirmation(workspace(), 11, "merge", "squash");
    expect(confirmation?.numbers).toEqual([10, 11]);
    expect(confirmation && stackConfirmationText(confirmation, []).text).toBe(
      "Merge #10, #11 into main using squash. A merge queue chooses its own method.",
    );
  });

  it("asks for a linked thread before any change", () => {
    const controls = stackControls({
      workspace: workspace(),
      number: 11,
      associated: false,
      busy: false,
    });
    expect(
      controls.every((control) => control.reason === "Link this pull request to a thread first."),
    ).toBe(true);
  });

  it("can't rebase without the thread's checkout of the stack", () => {
    const rebase = stackControls({
      workspace: workspace(),
      number: 11,
      associated: true,
      busy: false,
    }).find((control) => control.action === "rebase");
    expect(rebase?.reason).toBe("The thread's checkout doesn't match this stack.");
  });

  it("offers to abort a rebase that stopped on a conflict, and holds the merge until then", () => {
    const stopped = workspace({
      operation: { action: "rebase", state: "conflict", message: "stack/2 conflicts" },
    });
    const controls = stackControls({
      workspace: stopped,
      number: 11,
      associated: true,
      busy: false,
    });
    expect(controls.map((control) => control.action)).toEqual([
      "merge",
      "rebase",
      "continue",
      "abort",
    ]);
    expect(controls[0]?.reason).toBe("Finish or reconcile the current stack operation first.");
  });

  it("shows nothing for a pull request outside any stack", () => {
    expect(
      stackControls({
        workspace: workspace({ stack: null }),
        number: 11,
        associated: true,
        busy: false,
      }),
    ).toEqual([]);
  });
});
