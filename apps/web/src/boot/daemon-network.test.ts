import { expect, it } from "vitest";
import { authorizeDaemonUrl } from "./daemon-network.ts";

it("connection setup waits for desktop authorization before it can dial the selected host", async () => {
  let release: (() => void) | undefined;
  let permitted: string | undefined;
  let dialed = false;
  const scope = {
    ace: {
      daemon: {
        authorize: async (url: string) => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          permitted = url;
        },
      },
    },
  };
  const setup = authorizeDaemonUrl("https://selected.example/", scope).then(() => {
    dialed = true;
  });
  expect(dialed).toBe(false);
  release?.();
  await setup;
  expect(permitted).toBe("wss://selected.example/");
  expect(dialed).toBe(true);
});
it("a rejected desktop origin prevents connection setup", async () => {
  const scope = {
    ace: {
      daemon: {
        authorize: async () => {
          throw new Error("Untrusted host");
        },
      },
    },
  };
  await expect(authorizeDaemonUrl("https://remote.example/", scope)).rejects.toThrow(
    "Untrusted host",
  );
});
