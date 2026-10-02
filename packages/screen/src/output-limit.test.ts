import { expect, it } from "vitest";
import { access } from "node:fs/promises";
import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import { Helper } from "./index.ts";
import { deferred, ids } from "./testing/support.ts";
for (const stream of ["stdout", "stderr"]) {
  it(`terminates an idle helper emitting newline-free oversized ${stream}`, async () => {
    const outcome = deferred<Error | string>();
    let child: SupervisedProcess | undefined;
    let socketPath: string | undefined;
    const helper = await Helper.open({
      command: process.execPath,
      args: [
        "-e",
        `process.${stream}.write(Buffer.alloc(8 * 1024 * 1024, 120), () => console.log(JSON.stringify({version:1,id:'notice',ok:true,data:'overflow escaped'}))); process.stdin.resume();`,
        "--",
      ],
      nextId: ids(),
      spawn: (options) => {
        socketPath = options.args?.at(-1);
        child = spawnSupervised(options);
        child.stdout.on("line", (line: string) => {
          if (line.includes("overflow escaped")) outcome.resolve("overflow escaped");
        });
        return child;
      },
      onFrame: () => {},
      onFailure: (error) => outcome.resolve(error),
    });
    try {
      const result = await outcome.promise;
      expect(result).toBeInstanceOf(Error);
      expect(String(result)).toMatch(/output.*limit/i);
      await helper.close();
      expect(child?.signal.aborted).toBe(true);
      if (!socketPath) throw new Error("Missing socket path");
      await expect(access(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await helper.close();
    }
  });
}
