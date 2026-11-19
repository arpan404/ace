import { expect, test } from "vitest";
import { browserKeymap } from "./device-keymap.ts";

function sharedStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

test("a tab adopting the machine's old shortcuts keeps another tab's save it hasn't heard of yet", async () => {
  const storage = sharedStorage();
  const first = browserKeymap(storage);
  const second = browserKeymap(storage);

  await first.set({ palette: "shift+mod+y" });
  // The storage event hasn't reached the second tab when the old setting's reply does.
  expect(second.get()).toBeNull();
  await second.adopt({ palette: "alt+mod+p" });

  expect(second.get()).toEqual({ palette: "shift+mod+y" });
  expect(browserKeymap(storage).get()).toEqual({ palette: "shift+mod+y" });
});

test("a browser that never stored shortcuts adopts the machine's old ones", async () => {
  const storage = sharedStorage();
  await browserKeymap(storage).adopt({ palette: "alt+mod+p" });
  expect(browserKeymap(storage).get()).toEqual({ palette: "alt+mod+p" });
});

test("damaged saved shortcuts read as none rebound, so adopting doesn't replace them", async () => {
  const storage = sharedStorage();
  storage.setItem("ace.keybindings", JSON.stringify(["mod+k"]));
  const keymap = browserKeymap(storage);
  expect(keymap.get()).toEqual({});

  await keymap.adopt({ palette: "alt+mod+p" });

  expect(browserKeymap(storage).get()).toEqual({});
});
