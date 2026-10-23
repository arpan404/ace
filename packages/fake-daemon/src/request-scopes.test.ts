import { expect, test } from "vitest";
import { ClientMessage } from "@ace/protocol";
import { scopeRefusal } from "./request-scopes.ts";

const scopes = { reader: ["read"], operator: ["read", "operate"] } as const;
const message = (value: unknown) => ClientMessage.parse(value);

test("a read-only device may list provider accounts but not install or sign in", () => {
  const list = message({ type: "provider.accounts.list", requestId: "r1", provider: "codex" });
  expect(scopeRefusal(list, scopes, "reader")).toBeUndefined();
  const install = message({ type: "provider.install.plan", requestId: "r2", provider: "codex" });
  expect(scopeRefusal(install, scopes, "reader")).toEqual({
    type: "provider.install.result",
    requestId: "r2",
    result: { ok: false, error: "forbidden" },
  });
  expect(scopeRefusal(install, scopes, "operator")).toBeUndefined();
});

test("without configured scopes, every device may do everything", () => {
  const install = message({ type: "provider.install.plan", requestId: "r3", provider: "codex" });
  expect(scopeRefusal(install, undefined, "anyone")).toBeUndefined();
});
