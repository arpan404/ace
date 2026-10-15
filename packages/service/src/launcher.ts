const shell = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
/** The complete installed launcher program. Metadata never authorizes extra shell commands. */
export function renderLauncher(root: string): string {
  if (/[\r\n\0]/.test(root)) throw new Error("Invalid launcher home");
  return `#!/bin/sh\nACE_HOME=${shell(root)}\nexport ACE_HOME\ntarget=$(readlink "$ACE_HOME/current")\ncase "$target" in releases/*) ;; *) exit 1;; esac\nartifact="$ACE_HOME/$target"\nexec "$artifact/bin/node" "$artifact/ace.mjs" "$@"\n`;
}

/** Every `ace` command shim the desktop app writes carries this line (in a comment). */
export const CLI_SHIM_MARKER = "ace-cli-shim: written by the ace desktop app on launch";

/** Whether `content` is the desktop app's `ace` command shim rather than a release launcher. */
export function isDesktopShim(content: string): boolean {
  return (
    content.length <= 4096 &&
    content.split(/\r?\n/).some((line) => line.trim().endsWith(CLI_SHIM_MARKER))
  );
}
