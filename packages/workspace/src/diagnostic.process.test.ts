// Temporary Windows diagnostic; removed before the branch is finished.
import { watch as nodeWatch } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { workspaceRuntime } from "./index.ts";
import { batches, exec, fixture } from "./test-support.ts";

test.runIf(process.platform === "win32")("diagnose git metadata paths and raw events", async () => {
  const h = await fixture({}, true);
  console.log("DIAG root", JSON.stringify(h.root), "service", JSON.stringify(h.service.root));
  console.log("DIAG realpath", JSON.stringify(await realpath(h.root)));
  for (const name of ["HEAD", "index", "info/exclude", "config"]) {
    const out = await exec("git", ["rev-parse", "--path-format=absolute", "--git-path", name], {
      cwd: h.service.root,
    });
    console.log("DIAG git-path", name, JSON.stringify(out.stdout));
  }
  const cfg = await exec("git", ["config", "--null", "--show-origin", "--list"], {
    cwd: h.service.root,
  });
  console.log("DIAG origins", JSON.stringify(cfg.stdout.split("\0").filter((_, i) => i % 2 === 0)));
  console.log(
    "DIAG env",
    JSON.stringify({
      HOME: process.env.HOME,
      XDG: process.env.XDG_CONFIG_HOME,
      GCG: process.env.GIT_CONFIG_GLOBAL,
      USERPROFILE: process.env.USERPROFILE,
    }),
  );
  const raw: string[] = [];
  const w = nodeWatch(h.service.root, { recursive: true }, (event, filename) =>
    raw.push(`${event}:${String(filename)}`),
  );
  await h.file("tracked.log", "content");
  await exec("git", ["-C", h.root, "add", "-f", "tracked.log"]);
  await exec("git", ["-C", h.root, "symbolic-ref", "HEAD", "refs/heads/other"]);
  await h.file("marker", "x");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  w.close();
  console.log("DIAG raw", JSON.stringify(raw));
  expect(true).toBe(true);
});

test.runIf(process.platform === "win32")("diagnose included config watch", async () => {
  const peer = await fixture();
  const h = await fixture(
    { runtime: { environment: { ...workspaceRuntime().environment, HOME: peer.service.root } } },
    true,
  );
  const extra = join(peer.service.root, "nested/extra.conf");
  await peer.file("declaring.conf", `[include]\npath = ${extra}\n`);
  await peer.file("nested/extra.conf", "");
  await peer.file("rules", "a.ts\n");
  await h.file("a.ts", "untracked");
  await exec("git", [
    "-C",
    h.root,
    "config",
    "--add",
    "include.path",
    join(peer.service.root, "declaring.conf"),
  ]);
  const inc = await exec(
    "git",
    [
      "config",
      "--includes",
      "--null",
      "--show-origin",
      "--path",
      "--get-regexp",
      "^include(if\\..*)?\\.path$",
    ],
    { cwd: h.service.root },
  ).catch((error: unknown) => ({ stdout: String(error) }));
  console.log("DIAG includes", JSON.stringify(inc.stdout));
  const warnings: string[] = [];
  const events = batches();
  const subscription = await h.service.watch({
    onChange: events.onChange,
    onWarning: (message) => warnings.push(message),
  });
  console.log("DIAG mode", subscription.mode, JSON.stringify(warnings));
  const hidden = events.next("a.ts", "deleted");
  await peer.file(
    "nested/extra.conf",
    `[core]\nexcludesFile = ${join(peer.service.root, "rules")}\n`,
  );
  const result = await Promise.race([
    hidden.then(() => "hidden"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000)),
  ]);
  console.log(
    "DIAG include result",
    result,
    JSON.stringify(events.history),
    JSON.stringify(warnings),
  );
  await subscription.dispose();
});

test.runIf(process.platform === "win32")("diagnose spurious flush changes", async () => {
  const { service, file } = await fixture({}, true);
  await file(".gitignore", "node_modules/\n");
  for (let i = 0; i < 20; i++) await file(`node_modules/pkg${i}/lib/index.js`, "x");
  await file("src/app/main.ts", "main");
  const events = batches();
  const watcher = await service.watch({ onChange: events.onChange });
  await watcher.flush();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await watcher.flush();
  console.log("DIAG flush history", JSON.stringify(events.history));
  await watcher.dispose();
});
