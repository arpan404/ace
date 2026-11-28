import { expect, it } from "vitest";
import { deviceAuthenticate, type DeviceAuthDeps } from "./device-auth.ts";

function deps(overrides: Partial<DeviceAuthDeps>): DeviceAuthDeps {
  return {
    enrolledLevel: async () => "device",
    authenticate: async () => true,
    ...overrides,
  };
}

it("opens without auth only when the phone has no device credential", async () => {
  expect(await deviceAuthenticate("Unlock", deps({ enrolledLevel: async () => "none" }))).toBe(
    "unavailable",
  );
});

it("requires auth on a device-credential phone even without biometrics", async () => {
  let prompted = 0;
  const outcome = await deviceAuthenticate(
    "Unlock",
    deps({
      enrolledLevel: async () => "device",
      authenticate: async () => {
        prompted += 1;
        return true;
      },
    }),
  );
  expect(outcome).toBe("success");
  expect(prompted).toBe(1);
});

it("a refused prompt stays shut", async () => {
  expect(await deviceAuthenticate("Unlock", deps({ authenticate: async () => false }))).toBe(
    "failed",
  );
});

it("fails closed when the credential check itself is unavailable", async () => {
  expect(
    await deviceAuthenticate(
      "Unlock",
      deps({
        enrolledLevel: async () => {
          throw new Error("not available");
        },
      }),
    ),
  ).toBe("failed");
});

it("fails closed when the system prompt throws", async () => {
  expect(
    await deviceAuthenticate(
      "Unlock",
      deps({
        authenticate: async () => {
          throw new Error("lockout");
        },
      }),
    ),
  ).toBe("failed");
});
