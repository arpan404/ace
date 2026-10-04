import { expect, test } from "vitest";
import { reviewPermission } from "./index.ts";

test.each([".env", "secrets.json", ".codex/auth.json", ".aws/credentials"])(
  "a workspace read of %s requires a human even though its path is contained",
  (path) => {
    expect(
      reviewPermission({
        mode: "auto-review",
        target: { tool: "Read", access: "read", paths: [path] },
        paths: ["workspace"],
      }),
    ).toMatchObject({
      decision: "escalate",
      reason: "Secret or credential access requires a human",
    });
  },
);

test("a verified ordinary workspace read earns a reason but a write in read-only is denied", () => {
  expect(
    reviewPermission({
      mode: "auto-review",
      target: { tool: "Read", access: "read", paths: ["src/main.ts"] },
      paths: ["workspace-file"],
    }),
  ).toEqual({ decision: "approve", reason: "Read of verified non-secret workspace files" });
  expect(
    reviewPermission({
      mode: "read-only",
      target: { tool: "Write", access: "write", paths: ["src/main.ts"] },
      paths: ["workspace"],
    }),
  ).toEqual({ decision: "deny", reason: "Read-only mode does not permit this action" });
});

test.each([
  "rm -rf /outside",
  "rm -rf --dir=/outside",
  "rm -rf ./../outside",
  "rm -rf '$HOME'",
  "pwd; rm -rf build",
])("ambiguous or outside command %s cannot gain an automatic grant or silent denial", (command) => {
  expect(
    reviewPermission({
      mode: "auto-review",
      target: { tool: "shell", access: "execute", command },
      paths: [],
    }).decision,
  ).toBe("escalate");
});

test("an unknown tool cannot disguise its effects with a low-risk command field", () => {
  expect(
    reviewPermission({
      mode: "auto-review",
      target: { tool: "arbitrary-plugin", access: "unknown", command: "pwd" },
      paths: [],
    }).decision,
  ).toBe("escalate");
});

test.each(["Grep", "Glob", "arbitrary-plugin"])(
  "%s cannot earn approval from a contained path alone",
  (tool) => {
    expect(
      reviewPermission({
        mode: "auto-review",
        target: { tool, access: "read", paths: ["src/main.ts"] },
        paths: ["workspace-file"],
      }).decision,
    ).toBe("escalate");
  },
);

test("auto-review approves a wrapped Codex workspace inspection", () => {
  expect(
    reviewPermission({
      mode: "auto-review",
      target: {
        tool: "item/commandExecution/requestApproval",
        access: "execute",
        command: "/bin/zsh -lc 'pwd'",
      },
      paths: [],
    }).decision,
  ).toBe("approve");
});
test.each([
  "/bin/zsh -lc 'pwd; rm -rf build'",
  "/bin/zsh -lc 'cat .env'",
  "/bin/sh -c 'rm -rf build'",
  "/bin/zsh -lc 'pwd' extra",
])("wrapped command stays subject to the risk policy: %s", (command) => {
  expect(
    reviewPermission({
      mode: "auto-review",
      target: { tool: "shell", access: "execute", command },
      paths: [],
    }).decision,
  ).not.toBe("approve");
});
