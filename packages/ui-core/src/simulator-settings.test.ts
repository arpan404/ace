import type { Toolchain } from "@ace/protocol";
import { expect, test } from "vitest";
import { toolchainRow } from "./simulator-settings.ts";

const reported = (id: Toolchain["id"], available: boolean, version?: string): Toolchain => ({
  id,
  available,
  detail: "",
  hint: `Get ${id}`,
  ...(version ? { version } : {}),
});

test.each([
  {
    case: "a ready tool shows its version and no way to get it",
    tool: reported("xcode", true, "26.0"),
    row: { name: "iOS Simulator", status: "Ready", detail: "26.0", installer: null },
  },
  {
    case: "missing Xcode says what to do and where to get it",
    tool: reported("xcode", false),
    row: {
      name: "iOS Simulator",
      status: "Not installed",
      detail: "Get xcode",
      installer: { href: "https://apps.apple.com/app/xcode/id497799835", label: "Install Xcode" },
    },
  },
  {
    case: "missing Android emulators point to Android Studio",
    tool: reported("android", false),
    row: { status: "Not installed", installer: { label: "Install Android Studio" } },
  },
  {
    case: "missing simulator streaming has no outside installer: ace downloads it",
    tool: reported("serve-sim", false),
    row: { name: "Simulator streaming", status: "Not installed", installer: null },
  },
])("$case", ({ tool, row }) => {
  expect(toolchainRow(tool)).toMatchObject(row);
});
