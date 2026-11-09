import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

it("feeding a large file to a reader that hasn't started never stalls the search's own process", async () => {
  // The reader drains its pipes only once this process writes the go file, which it can do only
  // while its event loop runs. A writer that blocks on the full pipe would stall it until the
  // reader gives up.
  const go = join(await mkdtemp(join(tmpdir(), "ace-pipe-go-")), "go");
  const { service, file } = await fixture({
    runtime: {
      spawn(binary, args, options) {
        if (!args.includes("--json")) return spawn(binary, args, options);
        const count = args.filter((arg) => arg.startsWith("/dev/fd/")).length;
        return spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
        import { existsSync } from 'node:fs';
        import { spawn } from 'node:child_process';
        const { GO, RG, ARGS, COUNT } = process.env;
        const started = Date.now();
        while (!existsSync(GO)) {
          if (Date.now() - started > 5000) process.exit(3);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const child = spawn(RG, JSON.parse(ARGS), { stdio: ['ignore', 'inherit', 'inherit',
          ...Array.from({ length: Number(COUNT) }, (_, index) => index + 3)] });
        child.on('exit', (code) => process.exit(code ?? 1));
      `,
          ],
          {
            ...options,
            env: {
              ...options.env,
              GO: go,
              RG: binary,
              ARGS: JSON.stringify(args),
              COUNT: String(count),
            },
          },
        );
      },
    },
  });
  // Larger than any pipe buffer, so the writer has to wait for the reader.
  await file("big", "filler\n".repeat(150_000) + "needle\n");
  const searching = service.search({ query: "needle", limit: 10 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeFile(go, "");
  expect((await searching).matches).toEqual([
    { path: "big", line: 150_001, column: 1, preview: "needle" },
  ]);
});
