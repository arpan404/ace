import { expect, test } from "vitest";
import { bundledSpadeBinary, spadeInstallVersion } from "./service-control.ts";

const none = () => false;
const desktop = (path: string) => path === "/App/Resources/daemon/desktop-app.json";

test("the binary installed for Spade is ACE_SPADE_BIN in development, else the one in the daemon's bundle", () => {
  expect(bundledSpadeBinary({ ACE_SPADE_BIN: "/dev/spade" }, undefined, "darwin", none)).toBe(
    "/dev/spade",
  );
  // A standalone release: `<release>/ace.mjs`, `<release>/spade/spade-server`.
  expect(bundledSpadeBinary({}, "/home/.ace/releases/0.5.0/ace.mjs", "linux", none)).toBe(
    "/home/.ace/releases/0.5.0/spade/spade-server",
  );
  // The desktop app: `<resources>/daemon/ace.mjs` beside the app's marker, `<resources>/spade/`.
  expect(
    bundledSpadeBinary({ ACE_SPADE_BIN: "  " }, "/App/Resources/daemon/ace.mjs", "darwin", desktop),
  ).toBe("/App/Resources/spade/spade-server");
  expect(() => bundledSpadeBinary({}, undefined, "linux", none)).toThrow("ACE_SPADE_BIN");
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
