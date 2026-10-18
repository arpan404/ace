import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fixture, executablePath, ref } from "./test-support.ts";

const Snapshot = z.object({
  nodes: z.array(z.object({ ref: z.string().optional(), role: z.string(), name: z.string() })),
  truncated: z.boolean(),
  hint: z.string().optional(),
});
/** 50,000 element nodes plus their text: a long real-world list page. */
const largeList =
  "document.body.innerHTML='<main><h1>Orders</h1><ul>'+Array.from({length:26000},(_, i)=>'<li>row '+i+'</li>').join('')+'</ul></main>';0";

describe.skipIf(!executablePath)("visible text waits on real pages", () => {
  it("finds text that appears at the end of a 50,000-node page", async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate(largeList);
    await f.evaluate(
      "setTimeout(()=>{const p=document.createElement('p');p.textContent='Import finished';document.body.append(p)},300)",
    );
    await expect(
      f.execute({ action: "wait_for", text: "Import finished", timeout: 10_000 }),
    ).resolves.toMatchObject({ ok: true });
  });
  it("matches text split across inline elements but never hidden text", async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate(
      "document.body.innerHTML='<p hidden>Secret match</p><p>Visible <b>match</b></p><p style=\"visibility:hidden\">Ghost text</p>'",
    );
    await expect(
      f.execute({ action: "wait_for", text: "Secret match", timeout: 300 }),
    ).rejects.toMatchObject({ code: "timeout" });
    await expect(
      f.execute({ action: "wait_for", text: "Ghost text", timeout: 300 }),
    ).rejects.toMatchObject({ code: "timeout" });
    await f.execute({ action: "wait_for", text: "Visible match" });
  });
});

describe.skipIf(!executablePath)("snapshots of large pages", () => {
  it("outlines a page too large to read whole, and scopes into one of its parts", async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate(largeList);
    await f.evaluate(
      "document.body.insertAdjacentHTML('afterbegin','<nav aria-label=\"Site\"><a href=\"#a\">Account</a></nav>')",
    );
    const outline = Snapshot.parse(await f.execute({ action: "snapshot" }));
    expect(outline.truncated).toBe(true);
    expect(outline.hint).toMatch(/landmarks and headings/);
    expect(outline.nodes.map((node) => node.role)).toEqual(
      expect.arrayContaining(["main", "navigation", "heading"]),
    );
    expect(outline.nodes.some((node) => node.name.startsWith("row "))).toBe(false);

    const nav = outline.nodes.find((node) => node.role === "navigation")?.ref;
    if (!nav) throw new Error("No navigation ref in the outline");
    const part = Snapshot.parse(await f.execute({ action: "snapshot", ref: nav }));
    expect(part.truncated).toBe(false);
    const link = part.nodes.find((node) => node.role === "link" && node.name === "Account");
    expect(link?.ref).toBeDefined();
    // Refs from a scoped snapshot act like any other.
    await f.execute({ action: "click", ref: link?.ref });
    await expect(f.evaluate("location.hash")).resolves.toBe("#a");
  });
  it("says when a snapshot was cut short and how to read the rest", async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate(
      "document.body.innerHTML=Array.from({length:12000},(_, i)=>'<button>Item '+i+'</button>').join('');0",
    );
    const snapshot = Snapshot.parse(await f.execute({ action: "snapshot" }));
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.hint).toMatch(/Pass ref/);
  });
  it("reads only the levels asked for below a scoped element", async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate(
      'document.body.innerHTML=\'<nav aria-label="Menu"><ul><li><a href="#x">Deep link</a></li></ul></nav><button>Outside</button>\'',
    );
    const full = await f.execute({ action: "snapshot" });
    const menu = ref(full, "Menu");
    const shallow = Snapshot.parse(await f.execute({ action: "snapshot", ref: menu, depth: 1 }));
    expect(shallow.nodes[0]?.name).toBe("Menu");
    expect(shallow.nodes.some((node) => node.name === "Deep link")).toBe(false);
    const deep = Snapshot.parse(await f.execute({ action: "snapshot", ref: menu }));
    expect(deep.nodes.some((node) => node.name === "Deep link")).toBe(true);
    expect(deep.nodes.some((node) => node.name === "Outside")).toBe(false);
  });
});
