import { expect, test } from "vitest";
import type { FakeSpadeApi } from "@ace/fake-daemon";
import { until } from "./test-host.ts";
import { setUp } from "./spade-test-host.ts";

/*
 * Settings › Spade › Security on the iPhone (ADR 0167, ADR 0171 amendment 7): whether the
 * machine seals commands off, the Permissions every bot follows unless it sets its own, the apps
 * bots never use, and how bots decide. Each change is saved as it is made and answered with the
 * page as Spade now holds it; a refusal says why.
 */

const ready = async (seed: (fake: FakeSpadeApi) => void = () => {}) => {
  const host = await setUp((fake) => {
    fake.addAgent({ id: "spade", name: "Spade", kind: "main" });
    fake.addAgent({ id: "garden", name: "Garden" });
    seed(fake);
  });
  await until(() => host.spade.ready);
  return host;
};

type Security = {
  line: string;
  permissions: { key: string; title: string; line: string; on: boolean; own: boolean }[] | null;
  neverApps: string[] | null;
  autonomy: { value: string; fullAccess: string | null };
};
const page = (answer: unknown): Security => {
  if (answer && typeof answer === "object" && "security" in answer)
    return answer.security as Security;
  throw new Error(JSON.stringify(answer));
};

test("Security's first line says the machine seals commands off, and lists every permission in web's order", async () => {
  const { ask } = await ready();

  const security = page(await ask({ type: "spade.settings.read", page: "security" }));

  expect(security.line).toBe(
    "Commands run sealed off on this Mac. Every bot uses these unless it sets its own.",
  );
  expect(security.permissions?.map((row) => [row.title, row.on])).toEqual([
    ["Computer use", false],
    ["Browser", false],
    ["Simulators and devices", false],
    ["Apps", true],
    ["Commands outside the sandbox", false],
    ["Network beyond listed sites", false],
    ["Send as you", true],
    ["Payments", true],
  ]);
  expect(security.neverApps).toContain("1Password");
  expect(security.autonomy).toMatchObject({ value: "auto_review", fullAccess: null });
});

test("a machine that can't seal commands off says so on Security's first line", async () => {
  const { ask } = await ready((fake) => {
    fake.security.sandbox.network = "unavailable";
  });

  const security = page(await ask({ type: "spade.settings.read", page: "security" }));

  expect(security.line).toBe(
    "This Mac can't seal commands off yet, so Spade asks before they run. Every bot uses these unless it sets its own.",
  );
});

test("a permission turned off on the phone is off for a bot that doesn't set its own", async () => {
  const { ask, api } = await ready();

  const answer = await ask({ type: "spade.settings.permission", key: "apps", on: false });

  const apps = page(answer).permissions?.find((row) => row.key === "apps");
  expect(apps?.on).toBe(false);
  // What the bot's next turn reads: its own view follows the machine's default.
  const read = await api.answer({
    method: "GET",
    path: "/v1/agents/garden/security",
    body: undefined,
  });
  const garden = JSON.parse(read.body ?? "{}") as {
    permissions: { on: Record<string, boolean>; own: Record<string, boolean> };
  };
  expect(garden.permissions.on.apps).toBe(false);
  expect(garden.permissions.own.apps).toBe(false);
});

test("turning a permission on without the person's standing says it's theirs to do, and changes nothing", async () => {
  const { ask, api } = await ready((fake) => {
    fake.security.permissions.standing = false;
  });

  const answer = await ask({ type: "spade.settings.permission", key: "browser", on: true });

  expect(answer).toEqual({
    ok: false,
    title: "Couldn't turn on Browser",
    message:
      "Only you can make this change. Pair this iPhone again from ace on your computer to make it here, or make it there.",
  });
  expect(api.security.permissions.defaults.browser).toBe(false);
});

test("the apps bots never use change as a whole list, and Full access says what still asks", async () => {
  const { ask } = await ready();

  const listed = page(
    await ask({ type: "spade.settings.neverApps", apps: ["1Password", "Signal "] }),
  );
  const decided = page(await ask({ type: "spade.settings.autonomy", autonomy: "full_access" }));

  expect(listed.neverApps).toEqual(["1Password", "Signal"]);
  expect(decided.autonomy.value).toBe("full_access");
  expect(decided.autonomy.fullAccess).toMatch(/^It works without asking you or the reviewer/);
});

test("a Spade that refuses a change says why in its own words", async () => {
  const { ask, api, daemon } = await ready();
  daemon.spade.serve({
    answer: (request) =>
      request.path === "/v1/security/autonomy"
        ? { status: 409, body: JSON.stringify({ error: "A move is in progress." }) }
        : api.answer(request),
    open: (path) => api.open(path),
  });

  const answer = await ask({ type: "spade.settings.autonomy", autonomy: "full_access" });

  expect(answer).toEqual({
    ok: false,
    title: "Couldn't change how bots decide",
    message: "A move is in progress.",
  });
});
