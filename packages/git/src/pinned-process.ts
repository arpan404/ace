import { createRequire } from "node:module";
import { z } from "zod";
import { leaseHeldDirectory } from "./directory-lease.ts";
import type { GitProcessRuntime } from "./types.ts";

const require = createRequire(import.meta.url);
/** The helper's first argument: the process listing knows the group it leads as ace's Git. */
export const pinnedGitMarker = "ace-pinned-git";
// This helper changes only its own cwd. The inherited fd, rather than a pathname, selects it.
// Git and its helpers stay in this helper's supervised process group; argv never enters a shell.
const helper = `
const {spawn}=require("node:child_process");
const [ffiPath,binary,...args]=process.argv.slice(2);
const ffi=require(ffiPath);
const enter=ffi.load(null).func("int fchdir(int fd)");
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
  if (runtime.platform === "win32") return spawnLeased(runtime, binary, args, options, fd);
  return runtime.spawn(
    process.execPath,
    ["-e", helper, pinnedGitMarker, require.resolve("koffi"), binary, ...args],
    {
      ...options,
      cwd: "/",
      stdio: ["pipe", "pipe", "pipe", z.number().int().nonnegative().parse(fd)],
    },
  );
}

/** Windows: Git starts by the held directory's volume path while a lease keeps it in place. */
function spawnLeased(
  runtime: GitProcessRuntime,
  binary: string,
  args: string[],
  options: Parameters<GitProcessRuntime["spawn"]>[2],
  fd: number,
) {
  const lease = leaseHeldDirectory(fd);
  let child: ReturnType<GitProcessRuntime["spawn"]>;
  try {
    child = runtime.spawn(binary, args, {
      ...options,
      cwd: lease.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    lease.release();
    throw error;
  }
  child.once("spawn", () => {
    try {
      lease.verify();
    } catch {
      // The folder became a link while Git was starting: stop before it does any work there.
      child.kill("SIGKILL");
    }
  });
  child.once("exit", lease.release);
  child.once("error", lease.release);
  return child;
}
