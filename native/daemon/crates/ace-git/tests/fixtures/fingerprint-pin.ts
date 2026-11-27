import { createHash } from "node:crypto";

const commitFingerprint = createHash("sha256")
  .update(
    JSON.stringify({
      selection: { kind: "commit", paths: ["src/lib.rs"] },
      head: null,
      branch: null,
      base: null,
      from: "0".repeat(40),
      to: "1".repeat(40),
      conventions: [],
    }),
  )
  .digest("hex");

const prFingerprint = createHash("sha256")
  .update(
    JSON.stringify({
      selection: {
        kind: "pr",
        branch: "feature",
        base: "main",
        baseRef: "origin/main",
      },
      head: "a".repeat(40),
      branch: "feature",
      base: "b".repeat(40),
      from: "c".repeat(40),
      to: "a".repeat(40),
      conventions: [],
    }),
  )
  .digest("hex");

console.log(JSON.stringify({ commitFingerprint, prFingerprint }));