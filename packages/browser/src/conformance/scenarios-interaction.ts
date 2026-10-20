import { expect } from "vitest";
import type { ConformanceScenario } from "./engine.ts";
import { Snapshot, eventually, ref, visit } from "./scenario-support.ts";

const result = "document.getElementById('out').textContent";

export const interactionScenarios: ConformanceScenario[] = [
  {
    id: "input-by-ref",
    title: "click, type, press, select and check act on the elements their refs name",
    async run(page) {
      await visit(page, "/form", "Save");
      const snapshot = await page.execute({ action: "snapshot" });
      await page.execute({ action: "type", ref: ref(snapshot, "Name"), text: "Ada" });
      await page.execute({ action: "click", ref: ref(snapshot, "Save") });
      await eventually(async () => expect(await page.evaluate(result)).toBe("Saved Ada"));
      await page.execute({ action: "type", ref: ref(snapshot, "Keys"), text: "go" });
      await page.execute({ action: "press", ref: ref(snapshot, "Keys"), key: "Enter" });
      await eventually(async () => expect(await page.evaluate(result)).toBe("Entered go"));
      await page.execute({ action: "select", ref: ref(snapshot, "Choice"), values: ["b"] });
      expect(await page.evaluate("document.querySelector('select').value")).toBe("b");
      await page.execute({ action: "check", ref: ref(snapshot, "Agree") });
      expect(await page.evaluate("document.querySelector('[type=checkbox]').checked")).toBe(true);
    },
  },
  {
    id: "covered-click",
    title: "a click lands only where the element itself takes it, never on what covers it",
    async run(page) {
      await visit(page, "/covered", "Cookie banner");
      const snapshot = await page.execute({ action: "snapshot" });
      // A banner covers Buy entirely: nothing is clicked, and the agent is told why.
      await expect(
        page.execute({ action: "click", ref: ref(snapshot, "Buy") }),
      ).rejects.toMatchObject({ code: "covered" });
      expect(await page.evaluate(result)).toBe("Ready");
      // A sticky header hides Peek's centre but not its lower part: the click lands there.
      await page.execute({ action: "click", ref: ref(snapshot, "Peek") });
      await eventually(async () => expect(await page.evaluate(result)).toBe("Peeked"));
    },
  },
  {
    id: "stable-refs",
    title: "refs stay the same across snapshots of an unchanged page and keep working",
    async run(page) {
      await visit(page, "/form", "Save");
      const first = Snapshot.parse(await page.execute({ action: "snapshot" }));
      const second = Snapshot.parse(await page.execute({ action: "snapshot" }));
      const refs = (snapshot: typeof first) =>
        snapshot.nodes.flatMap((node) =>
          node.ref ? [`${node.role}:${node.name}=${node.ref}`] : [],
        );
      expect(refs(second)).toEqual(refs(first));
      expect(refs(first).length).toBeGreaterThan(3);
      // A ref from the earlier snapshot still reaches its element.
      await page.execute({ action: "type", ref: ref(first, "Name"), text: "kept" });
      await page.execute({ action: "click", ref: ref(first, "Save") });
      await eventually(async () => expect(await page.evaluate(result)).toBe("Saved kept"));
    },
  },
];
