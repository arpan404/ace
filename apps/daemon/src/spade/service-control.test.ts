import { expect, test } from "vitest";
import { bundledSpadeBinary, spadeInstallVersion } from "./service-control.ts";

test("the binary installed for Spade is ACE_SPADE_BIN in development, else the one beside the runtime", () => {
  expect(bundledSpadeBinary({ ACE_SPADE_BIN: "/dev/spade" }, "/app/bin/node", "darwin")).toBe(
    "/dev/spade",
  );
  expect(bundledSpadeBinary({}, "/app/bin/node", "linux")).toBe("/app/bin/spade-server");
  expect(bundledSpadeBinary({ ACE_SPADE_BIN: "  " }, "/app/bin/node", "darwin")).toBe(
    "/app/bin/spade-server",
  );
});

const ace = async () => "0.0.19";
const stamped = async () => "0.0.19-dev.4\n";

test("a release's binary installs under ace's version, a development build under its own stamp", async () => {
  expect(await spadeInstallVersion({}, ace, stamped)).toBe("0.0.19");
  expect(await spadeInstallVersion({ ACE_SPADE_BIN: "/dev/spade" }, ace, stamped)).toBe(
    "0.0.19-dev.4",
  );
  await expect(
    spadeInstallVersion({ ACE_SPADE_BIN: "/dev/spade" }, ace, async () => "../escape"),
  ).rejects.toThrow("--version answered");
});
