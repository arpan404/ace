// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";

const cwd = new URL("../native/media/", import.meta.url);
for (const args of [
  ["fmt", "--all", "--check"],
  ["clippy", "--workspace", "--all-targets", "--locked"],
  ["test", "--workspace", "--locked"],
  ["deny", "check", "licenses", "sources"],
]) {
  execFileSync("cargo", args, { cwd, stdio: "inherit" });
}
