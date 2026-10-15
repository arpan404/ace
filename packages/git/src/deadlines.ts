/**
 * Deadline for Git writes that run a person's hooks or check out a whole tree (commit, merge,
 * switch, worktree add). A pre-commit hook that runs a test suite routinely exceeds the default
 * deadline. These calls stay cancellable through their signal and service close.
 */
export const longWriteTimeoutMs = 600_000;
