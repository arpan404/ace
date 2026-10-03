import type { Fact } from "@ace/core";
import type { FileChange } from "@ace/protocol";
import { tool, toolDone } from "./facts.ts";

/**
 * The edits the workbench threads made before they stopped to ask, so their Changes tab, the
 * transcript's changed-files card and More › Files all read the same diffs.
 */
function edit(key: string, changes: FileChange[]): Fact[] {
  const [first] = changes;
  return [
    tool("root", key, {
      kind: "file.edit",
      title: first ? `Edit ${first.path}` : "Edit files",
      detail: { kind: "file.edit", changes },
    }),
    toolDone("root", key),
  ];
}

const restartBudget = `/** How many times the supervisor restarts app-server before it gives up. */
export interface RestartBudget {
  attempts: number;
  windowMs: number;
  firstDelayMs: number;
  maxDelayMs: number;
}

export const restartBudget: RestartBudget = {
  attempts: 6,
  windowMs: 5 * 60_000,
  firstDelayMs: 250,
  maxDelayMs: 30_000,
};

/** The delay before restart number \`attempt\` (0-based): doubling, capped. */
export function restartDelay(budget: RestartBudget, attempt: number): number {
  return Math.min(budget.maxDelayMs, budget.firstDelayMs * 2 ** attempt);
}

/** Restarts inside the window, oldest first; the supervisor stops once this is full. */
export function spent(budget: RestartBudget, restarts: readonly number[], now: number): number {
  return restarts.filter((at) => now - at < budget.windowMs).length;
}
`;

const supervisorDiff = `@@ -1,9 +1,11 @@
 import { spawn } from "node:child_process";
+import { restartBudget, restartDelay, spent } from "./restart-budget.ts";
 import { log } from "../log.ts";
 
 export class Supervisor {
   private child: ReturnType<typeof spawn> | undefined;
+  private restarts: number[] = [];
 
   start() {
     this.child = spawn("codex", ["app-server"], { stdio: "pipe" });
     this.child.on("exit", (code) => this.onExit(code));
   }
@@ -12,7 +14,14 @@
   private onExit(code: number | null) {
     log.warn("app-server exited", { code });
-    this.start();
+    const now = Date.now();
+    const attempt = spent(restartBudget, this.restarts, now);
+    if (attempt >= restartBudget.attempts) {
+      log.error("app-server keeps crashing; giving up", { attempts: attempt });
+      return;
+    }
+    this.restarts.push(now);
+    setTimeout(() => this.start(), restartDelay(restartBudget, attempt));
   }
 }`;

export function retryBudgetEdits(): Fact[] {
  return [
    ...edit("edit-restart-budget", [
      { path: "src/supervisor/restart-budget.ts", kind: "add", newText: restartBudget },
    ]),
    ...edit("edit-supervisor", [
      { path: "src/supervisor/supervisor.ts", kind: "update", diff: supervisorDiff },
    ]),
  ];
}

const taxDiff = `@@ -18,12 +18,15 @@ export function refundLines(order: Order, refund: RefundRequest): RefundLine[] {
   return refund.items.map((item) => {
     const line = order.lines.find((candidate) => candidate.id === item.lineId);
     if (!line) throw new RefundError("unknown_line", item.lineId);
-    const net = line.unitPrice * item.quantity;
-    const tax = taxFor(order, net) + line.tax;
-    return { lineId: line.id, net, tax, total: net + tax };
+    // Tax is refunded in proportion to the quantity returned, from the line's own tax,
+    // never recomputed from the whole order (which counted it twice).
+    const share = item.quantity / line.quantity;
+    const net = round(line.unitPrice * item.quantity);
+    const tax = round(line.tax * share);
+    return { lineId: line.id, net, tax, total: net + tax };
   });
 }`;

const taxTest = `import { describe, expect, test } from "vitest";
import { refundLines } from "./tax.ts";
import { taxedOrder } from "../fixtures/orders.ts";

describe("partial refunds", () => {
  test("refund tax in proportion to the quantity returned", () => {
    const order = taxedOrder({ quantity: 4, unitPrice: 2500, taxRate: 0.1 });
    const [line] = refundLines(order, { items: [{ lineId: "line-1", quantity: 1 }] });
    expect(line).toMatchObject({ net: 2500, tax: 250, total: 2750 });
  });

  test("a full refund returns exactly the tax that was charged", () => {
    const order = taxedOrder({ quantity: 3, unitPrice: 999, taxRate: 0.0825 });
    const [line] = refundLines(order, { items: [{ lineId: "line-1", quantity: 3 }] });
    expect(line?.tax).toBe(order.lines[0]?.tax);
  });
});
`;

export function refundTaxEdits(): Fact[] {
  return [
    ...edit("edit-tax", [{ path: "src/refunds/tax.ts", kind: "update", diff: taxDiff }]),
    ...edit("edit-tax-test", [{ path: "src/refunds/tax.test.ts", kind: "add", newText: taxTest }]),
  ];
}

const installBefore = `# Installing ace

Download the app for your platform and drag it to Applications.

## Building from source

1. Clone the repository.
2. Run \`bun install\`.
3. Run \`bun run build\`.
`;

const installAfter = `# Install the ace daemon

ace runs as a small daemon on your machine and drives the coding agents you already use.

## Start it

\`\`\`sh
bunx @ace/cli start
\`\`\`

The daemon prints a pairing link. Open it in the browser, or scan the QR code with the phone app.

## Run it as a service

\`\`\`sh
ace service install
\`\`\`

The service starts at login and restarts the daemon if it exits. \`ace service uninstall\` removes it.

## Requirements

- Node 24 or later
- At least one coding agent CLI, installed and logged in (Claude Code, Codex, OpenCode or Cursor)
`;

const legacyInstall = `# Legacy installer

The .pkg installer is no longer published. Use \`ace start\` instead.
`;

export function installPageEdits(): Fact[] {
  return [
    ...edit("edit-install", [
      { path: "docs/install.md", kind: "update", oldText: installBefore, newText: installAfter },
    ]),
    ...edit("delete-legacy", [
      { path: "docs/legacy-install.md", kind: "delete", oldText: legacyInstall },
    ]),
  ];
}
