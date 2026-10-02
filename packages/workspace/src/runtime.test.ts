import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createWorkspace } from "./index.ts";

it("uses the injected real process boundary for ripgrep selection and search", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-workspace-runtime-"));
  try {
    await writeFile(join(root, "file"), "needle\n");
    const workspace = await createWorkspace(root, {
      ripgrep: "injected-ripgrep",
      runtime: {
        spawn(binary, args, options) {
          if (binary !== "injected-ripgrep") return spawn(binary, args, options);
          const source = args.includes("--version")
            ? 'console.log("ripgrep injected")'
            : 'process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify({type:"match",data:{lines:{text:"needle\\n"},line_number:1,submatches:[{match:{text:"needle"},start:0,end:6}]}})))';
          return spawn(process.execPath, ["-e", source], options);
        },
      },
    });
    const result = await workspace.search({ query: "needle", limit: 1 });
    expect(result.backend).toBe("ripgrep");
    expect(result.matches).toMatchObject([{ path: "file", line: 1, preview: "needle" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("uses the injected real worker boundary and reports its rejected search", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-workspace-worker-"));
  try {
    await writeFile(join(root, "file"), "needle\n");
    const workspace = await createWorkspace(root, {
      ripgrep: null,
      runtime: {
        createWorker() {
          return new Worker(
            'const { parentPort } = require("node:worker_threads"); parentPort.on("message", () => parentPort.postMessage({error:"injected worker rejection"}));',
            { eval: true },
          );
        },
      },
    });
    await expect(workspace.search({ query: "needle", limit: 1 })).rejects.toMatchObject({
      code: "SEARCH_FAILED",
      message: "injected worker rejection",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
