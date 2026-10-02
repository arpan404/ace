import { vi } from "vitest";

// These are hang guards, not performance assertions. Native startup and macOS
// process inventories share CPU with other worktrees on development machines.
export function configureRealPtyTests(): void {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
}
