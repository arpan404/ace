import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { utimes } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Development only: rebuilds ace's Rust add-on (ADR 0125) when anything under `rust/` changes,
 * then touches `@ace/native`'s loader. The daemon runs under `bun --watch`, which restarts it
 * when an imported source file changes, so the restarted daemon loads the new add-on. A
 * failed build leaves the previous add-on in place and the daemon running.
 */
const repo = resolve(import.meta.dirname, "../../..");
const rust = join(repo, "rust");
const loader = join(repo, "packages/native/src/binding.ts");
const settleMs = 300;

let timer: NodeJS.Timeout | undefined;
let building = false;
let again = false;

function build(): void {
  if (building) {
    again = true;
    return;
  }
  building = true;
  const child = spawn(process.execPath, [join(repo, "packages/native/build.ts")], {
    cwd: repo,
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    building = false;
    const done =
      code === 0
        ? utimes(loader, new Date(), new Date()).then(() =>
            console.log("add-on rebuilt; the daemon restarts with it"),
          )
        : Promise.resolve(console.log("build failed; the daemon keeps the previous add-on"));
    void done.then(() => {
      if (again) {
        again = false;
        build();
      }
    });
  });
}

watch(rust, { recursive: true }, (_event, name) => {
  // Cargo's own output lives under rust/target; watching it would rebuild forever.
  if (!name || name.startsWith("target")) return;
  if (!/\.(rs|toml)$|Cargo\.lock$/.test(name)) return;
  clearTimeout(timer);
  timer = setTimeout(build, settleMs);
});
console.log("watching rust/ for add-on changes");
