import { expect, test } from "vitest";
import { Availability } from "./plugin-availability.ts";

test("a follower attaches once per instance and drops the replaced one's attachment", () => {
  const log: string[] = [];
  const available = new Availability<{ name: string }>((value) => {
    log.push(`attach ${value.name}`);
    return () => log.push(`detach ${value.name}`);
  });
  const first = { name: "first" };
  available.publish(first);
  available.publish(first);
  available.publish({ name: "second" });
  available.close();
  available.publish({ name: "late" });
  expect(log).toEqual(["attach first", "detach first", "attach second", "detach second"]);
});
