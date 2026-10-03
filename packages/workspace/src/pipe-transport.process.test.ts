import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { fixture } from "./test-support.ts";

it("streams batched matches to tools that reopen inherited POSIX pipes", async () => {
  const { service, file } = await fixture({
    runtime: {
      spawn(binary, args, options) {
        if (!args.includes("--json")) return spawn(binary, args, options);
        // Linux cannot reopen Node's socket-backed stdio through /dev/fd.
        // This real process requires reopenable pipes, then runs real ripgrep.
        return spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
        import { fstatSync } from 'node:fs';
        import { spawn } from 'node:child_process';
        const args = JSON.parse(process.argv[1]);
        const count = args.filter(arg => arg.startsWith('/dev/fd/')).length;
        for (let index = 0; index < count; index++) {
          if (!fstatSync(index + 3).isFIFO()) throw new Error('Descriptor path requires a POSIX pipe');
        }
        const child = spawn(process.argv[2], args, { stdio: ['ignore', 'inherit', 'inherit',
          ...Array.from({ length: count }, (_, index) => index + 3)] });
        child.on('exit', code => process.exit(code ?? 1));
      `,
            JSON.stringify(args),
            binary,
          ],
          options,
        );
      },
    },
  });
  await file("a", "needle\n");
  await file("b", "needle needle\n");
  const result = await service.search({ query: "needle", limit: 100 });
  expect(result.matches).toEqual([
    { path: "a", line: 1, column: 1, preview: "needle" },
    { path: "b", line: 1, column: 1, preview: "needle needle" },
    { path: "b", line: 1, column: 8, preview: "needle needle" },
  ]);
});
