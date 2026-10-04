const shell = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
/** The complete installed launcher program. Metadata never authorizes extra shell commands. */
export function renderLauncher(root: string): string {
  if (/[\r\n\0]/.test(root)) throw new Error("Invalid launcher home");
  return `#!/bin/sh\nACE_HOME=${shell(root)}\nexport ACE_HOME\ntarget=$(readlink "$ACE_HOME/current")\ncase "$target" in releases/*) ;; *) exit 1;; esac\nartifact="$ACE_HOME/$target"\nexec "$artifact/bin/node" "$artifact/ace.mjs" "$@"\n`;
}
