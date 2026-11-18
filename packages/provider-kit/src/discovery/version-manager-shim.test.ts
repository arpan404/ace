import { expect, test } from "vitest";
import { versionManagerShim } from "./index.ts";

test.each([
  ["/home/p/.local/share/mise/shims/claude", "/usr/bin/mise", "mise"],
  ["/home/p/.local/share/mise/command-wrappers/bin/codex", "/usr/bin/mise", "mise"],
  ["/opt/tools/claude", "/home/p/.cargo/bin/rtx", "mise"],
  ["/home/p/.asdf/shims/codex", "/home/p/.asdf/shims/codex", "asdf"],
  ["/home/p/.volta/bin/codex", "/home/p/.volta/bin/volta-shim", "volta"],
  ["/home/p/.proto/shims/node", "/home/p/.proto/shims/node", "proto"],
  ["C:\\Users\\p\\.proto\\shims\\node.exe", "C:\\Users\\p\\.proto\\bin\\proto-shim.exe", "proto"],
] as const)("%s is recognized as a %s shim without running it", (path, target, manager) => {
  expect(versionManagerShim(path, target)).toBe(manager);
});

test.each([
  ["/home/p/.local/share/mise/installs/claude/latest/claude"],
  ["/usr/bin/codex"],
  ["/home/p/.local/bin/claude"],
  ["/home/p/shims-notes/codex"],
])("%s is an installed CLI, not a shim", (path) => {
  expect(versionManagerShim(path, path)).toBeUndefined();
});
