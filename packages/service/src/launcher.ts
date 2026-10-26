const shell = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
/** The complete installed launcher program. Metadata never authorizes extra shell commands. */
export function renderLauncher(root: string): string {
  if (process.platform === "win32") return renderCmdLauncher(root);
  if (/[\r\n\0]/.test(root)) throw new Error("Invalid launcher home");
  return `#!/bin/sh\nACE_HOME=${shell(root)}\nexport ACE_HOME\ntarget=$(readlink "$ACE_HOME/current")\ncase "$target" in releases/*) ;; *) exit 1;; esac\nartifact="$ACE_HOME/$target"\nexec "$artifact/bin/node" "$artifact/ace.mjs" "$@"\n`;
}

/** The installed launcher's name inside the home's `bin` directory on Windows. */
export const CMD_LAUNCHER = "ace.cmd";

const releaseLine = "releases/[0123456789abcdefghijklmnopqrstuvwxyz.-]*";

/**
 * Windows' `bin\ace.cmd`. `current` is a pointer file there (ADR 0095), so the script checks
 * that every line of it is a plain `releases/...` name before reading it: no other characters
 * ever reach the command line.
 */
function renderCmdLauncher(root: string): string {
  if (/["%\r\n\0]/.test(root)) throw new Error("Invalid launcher home");
  return [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    `set "ACE_HOME=${root}"`,
    `findstr /r /x /c:"${releaseLine}" "%ACE_HOME%\\current" >nul 2>nul || exit /b 1`,
    `findstr /r /x /v /c:"${releaseLine}" "%ACE_HOME%\\current" >nul 2>nul && exit /b 1`,
    `findstr /l /c:".." "%ACE_HOME%\\current" >nul 2>nul && exit /b 1`,
    `set "ACE_RELEASE_DIR="`,
    `set /p ACE_RELEASE_DIR=<"%ACE_HOME%\\current"`,
    `set "ACE_RELEASE_DIR=%ACE_HOME%\\%ACE_RELEASE_DIR:/=\\%"`,
    `"%ACE_RELEASE_DIR%\\bin\\node.exe" "%ACE_RELEASE_DIR%\\ace.mjs" %*`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
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
