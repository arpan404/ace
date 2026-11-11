import { expect, test } from "vitest";
import { bundledSpadeBinary } from "./service-control.ts";

test("the binary installed for Spade is ACE_SPADE_BIN in development, else the one beside the runtime", () => {
  expect(bundledSpadeBinary({ ACE_SPADE_BIN: "/dev/spade" }, "/app/bin/node", "darwin")).toBe(
    "/dev/spade",
  );
  expect(bundledSpadeBinary({}, "/app/bin/node", "linux")).toBe("/app/bin/spade-server");
  expect(bundledSpadeBinary({ ACE_SPADE_BIN: "  " }, "/app/bin/node", "darwin")).toBe(
    "/app/bin/spade-server",
  );
});
