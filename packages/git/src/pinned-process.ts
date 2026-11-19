import { z } from "zod";
import type { GitProcessRuntime } from "./types.ts";

/** The helper's first argument: the process listing knows the group it leads as ace's Git. */
export const pinnedGitMarker = "ace-pinned-git";
// This helper changes only its own cwd. The inherited fd, rather than a pathname, selects it.
// Git and its helpers stay in this helper's supervised process group; argv never enters a shell.
// It runs on the daemon's runtime, Bun, whose bun:ffi binds fchdir. Run under the name `node`,
// Bun leaves the first argument after the code out of process.argv: the marker may be missing.
const helper = `
const {spawn}=require("node:child_process");
const given=process.argv.slice(1);
const [binary,...args]=given[0]===${JSON.stringify(pinnedGitMarker)}?given.slice(1):given;
const libc=process.platform==="darwin"?"/usr/lib/libSystem.B.dylib":"libc.so.6";
const enter=require("bun:ffi").dlopen(libc,{fchdir:{args:["i32"],returns:"i32"}}).symbols.fchdir;
if(enter(3)!==0) process.exit(126);
require("node:fs").closeSync(3);
const child=spawn(binary,args,{stdio:["inherit","inherit","inherit"],shell:false});
child.once("error",()=>process.exit(127));
child.once("exit",(code,signal)=>{if(signal) process.kill(process.pid,signal); else process.exit(code??1);});
`;
export function spawnPinned(
  runtime: GitProcessRuntime,
  binary: string,
  args: string[],
  options: Parameters<GitProcessRuntime["spawn"]>[2],
  fd: number,
) {
  return runtime.spawn(process.execPath, ["-e", helper, pinnedGitMarker, binary, ...args], {
    ...options,
    cwd: "/",
    stdio: ["pipe", "pipe", "pipe", z.number().int().nonnegative().parse(fd)],
  });
}
