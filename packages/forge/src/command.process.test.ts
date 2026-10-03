import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createCommandRunner, detectRepository } from "./index.ts";
import { repository } from "./testing/fixtures.ts";

it("detects the origin in a real git repository and honours a selected remote", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "forge-git-"));
  try {
    const runner = createCommandRunner({ cwd });
    const signal = new AbortController().signal;
    for (const args of [
      ["init"],
      ["remote", "add", "fork", "git@gitlab.com:team/sub/ace.git"],
      ["remote", "add", "origin", "git@github.com:octo/ace.git"],
    ]) {
      expect((await runner({ command: "git", args, signal, mode: "json" })).code).toBe(0);
    }
    expect(await detectRepository(runner, signal)).toEqual(repository);
    expect(await detectRepository(runner, signal, { remote: "fork" })).toMatchObject({
      forge: "gitlab",
      owner: "team/sub",
    });
    await expect(detectRepository(runner, signal, { remote: "absent" })).rejects.toMatchObject({
      kind: "not_found",
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

describe("bounded command owner", () => {
  it("cancels a live child after it signals readiness without leaking stderr", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forge-cancel-"));
    try {
      const { createServer } = await import("node:net");
      const controller = new AbortController();
      const server = createServer((socket) => {
        socket.destroy();
        controller.abort();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Expected TCP address");
        const runner = createCommandRunner({ cwd });
        await expect(
          runner({
            command: process.execPath,
            args: [
              "-e",
              `require('node:net').connect(${address.port},'127.0.0.1');process.stderr.write('ghp_private');setInterval(()=>{},1000)`,
            ],
            signal: controller.signal,
            mode: "json",
          }),
        ).rejects.toMatchObject({ kind: "cancelled" });
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it("disables CLI debug output and bounds a giant unterminated JSON line", async () => {
    const runner = createCommandRunner({
      cwd: tmpdir(),
      env: { GH_DEBUG: "api", DEBUG: "*" },
      maxBytes: 128,
    });
    const signal = new AbortController().signal;
    const output = await runner({
      command: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify({debug:process.env.GH_DEBUG??null,generic:process.env.DEBUG??null}))",
      ],
      signal,
      mode: "json",
    });
    expect(JSON.parse(output.stdout)).toEqual({ debug: null, generic: null });
    await expect(
      runner({
        command: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(100000))"],
        signal,
        mode: "json",
      }),
    ).rejects.toMatchObject({ kind: "limit" });
    await expect(
      runner({ command: "ace-missing-gh-binary", args: [], signal, mode: "json" }),
    ).rejects.toMatchObject({ kind: "cli" });
  });
});
