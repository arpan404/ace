/**
 * OpenCode's own top-level tools (2.0.29). They are never part of Code Mode, so `execute` and
 * its `search()` never list them. A model that only reads the Code Mode catalog concludes it has
 * no shell or file access; this guidance names them so it doesn't.
 */
export const openCodeNativeTools = [
  "read",
  "write",
  "edit",
  "shell",
  "grep",
  "glob",
  "webfetch",
  "websearch",
  "subagent",
  "skill",
] as const;

export const openCodeNativeToolGuidance = [
  `OpenCode's own tools stay available beside ace's: ${openCodeNativeTools.join(", ")} and the rest of your direct tool list.`,
  "Call them directly by name, never through execute. Code Mode's catalog and search() cover only Code Mode tools, so a tool missing there is not missing from this session.",
  "Use them for files, shell commands, builds and the web; ace's tools are extras and never replace them. This session's permissions decide which may run.",
  "Delegate parallel work with ace_delegate_task, not the native subagent tool (see the ace-agents skill).",
  "Link any PR you open with ace_thread_link_pr, and read this project's recent work with ace_context.",
].join("\n");
