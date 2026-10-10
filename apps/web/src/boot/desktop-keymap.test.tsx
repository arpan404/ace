import { screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

afterEach(() => vi.unstubAllGlobals());

test("a native menu click opens its action after the shortcut has been rebound", async () => {
  let action: ((id: string) => void) | undefined;
  const synchronized = Promise.withResolvers<void>();
  vi.stubGlobal("ace", {
    keymap: {
      async update(bindings: Record<string, string>) {
        if (bindings.palette === "mod+shift+j") synchronized.resolve();
      },
      onAction(listener: typeof action) {
        action = listener;
        return () => {};
      },
    },
  });
  const app = harness();
  await app.client.start();
  await waitFor(() => expect(app.client.state).toBe("ready"));
  await app.client.request({
    type: "settings.set",
    key: "clients.keybindings",
    value: { palette: "mod+shift+j" },
    layer: { kind: "global" },
  });
  await app.open("/settings/general");
  await synchronized.promise;
  action?.("palette");
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Search commands" })).toBeTruthy(),
  );
});
