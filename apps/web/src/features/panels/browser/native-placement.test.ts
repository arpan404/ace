import { expect, test } from "vitest";
import { NativePlacement } from "./native-placement.ts";
import type { NativeViewPlacement } from "@/boot/desktop-browser.ts";

test("moving a shown page or changing its controller keeps it shown through pending receipts", async () => {
  const pending: ReturnType<typeof Promise.withResolvers<"shown">>[] = [];
  let shown = false;
  const controller = new NativePlacement({
    place: () => {
      const reply = Promise.withResolvers<"shown">();
      pending.push(reply);
      return reply.promise;
    },
    changed: (value) => {
      shown = value;
    },
    after: () => () => {},
  });
  const page: NativeViewPlacement = {
    threadId: "thread",
    visible: true,
    bounds: { x: 50, y: 90, width: 400, height: 600 },
  };
  controller.place(page);
  pending[0]?.resolve("shown");
  await Promise.resolve();
  expect(shown).toBe(true);
  controller.place({ ...page, bounds: { ...page.bounds, x: 100 } });
  controller.place({ ...page, bounds: { ...page.bounds, x: 120 }, owner: "person" });
  controller.visibility("thread", true);
  expect(shown).toBe(true);
  controller.place({ ...page, bounds: { ...page.bounds, width: 350 } });
  expect(shown).toBe(false);
  pending.at(-1)?.resolve("shown");
  await Promise.resolve();
  expect(shown).toBe(true);
  controller.close();
});
