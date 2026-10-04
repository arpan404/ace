import { createRequire } from "node:module";
import { z } from "zod";
import type { GitProcessRuntime } from "./types.ts";

const require = createRequire(import.meta.url);
// This helper changes only its own cwd. The inherited fd, rather than a pathname, selects it.
// Git and its helpers stay in this helper's supervised process group; argv never enters a shell.
const helper = `
const {spawn}=require("node:child_process");
const [ffiPath,binary,...args]=process.argv.slice(1);
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
  return runtime.spawn(
    process.execPath,
    ["-e", helper, require.resolve("koffi"), binary, ...args],
    {
      ...options,
      cwd: "/",
      stdio: ["pipe", "pipe", "pipe", z.number().int().nonnegative().parse(fd)],
    },
  );
}
