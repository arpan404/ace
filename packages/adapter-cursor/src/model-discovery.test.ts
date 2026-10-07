import { expect, test } from "vitest";
import { cursorModelsInHost } from "./index.ts";
import type { SdkModule } from "./runtime-boundary.ts";

function boundary(status: "logged-in" | "logged-out", list: SdkModule["Cursor"]["models"]["list"]) {
  return {
    Cursor: {
      auth: {
        status: async () =>
          status === "logged-in" ? { status, backendUrl: "https://fake.invalid" } : { status },
        login: async () => {
          throw new Error("Discovery must not log in");
        },
        logout: async () => {
          throw new Error("Discovery must not log out");
        },
      },
      models: { list },
    },
  };
}

test("a signed-out SDK reports missing setup before attempting a model request", async () => {
  const sdk = boundary("logged-out", async () => {
    throw new Error("Model endpoint must not be reached");
  });
  await expect(cursorModelsInHost(sdk, undefined)).rejects.toMatchObject({
    code: "not_configured",
  });
});

test("an empty environment key fails setup even when the SDK store reports signed in", async () => {
  const sdk = boundary("logged-in", async () => {
    throw new Error("Model endpoint must not be reached");
  });
  await expect(cursorModelsInHost(sdk, false)).rejects.toMatchObject({ code: "not_configured" });
});

test.each([undefined, true])(
  "SDK sign-in or an inherited environment key permits metadata listing (%s)",
  async (environment) => {
    const models = [{ id: "synthetic", displayName: "Synthetic" }];
    const sdk = boundary(environment ? "logged-out" : "logged-in", async () => models);
    expect(await cursorModelsInHost(sdk, environment)).toEqual(models);
  },
);

test.each([
  [{ name: "AuthenticationError", status: 401, message: "Bearer private-key" }, "auth_expired"],
  [{ status: 403, message: "private-key" }, "auth_expired"],
  [{ name: "NetworkError", message: "private-host" }, "unreachable"],
  [{ status: 503, message: "private-host" }, "unreachable"],
])("model failures retain only a category across the SDK boundary (%j)", async (error, code) => {
  const sdk = boundary("logged-in", async () => {
    throw error;
  });
  try {
    await cursorModelsInHost(sdk, undefined);
    throw new Error("Expected SDK failure");
  } catch (failure) {
    expect(failure).toMatchObject({ code, message: "Cursor SDK model discovery failed" });
    expect(JSON.stringify(failure)).not.toContain("private");
  }
});
