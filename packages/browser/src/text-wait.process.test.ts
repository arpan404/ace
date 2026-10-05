import { describe, expect, it } from "vitest";
import { fixture, executablePath } from "./test-support.ts";
describe.skipIf(!executablePath)("bounded visible page waits", () => {
  it("returns a readable limit error for a giant text node instead of scanning it on every poll", async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate("document.body.textContent='x'.repeat(65537)");
    await expect(f.execute({ action: "wait_for", text: "absent" })).rejects.toMatchObject({
      code: "page_text_limit",
    });
    await f.evaluate("document.body.textContent='Saved bounded text'");
    await f.execute({ action: "wait_for", text: "Saved bounded text" });
  });
  it("bounds empty DOM traversal and ignores hidden text", async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate("document.body.innerHTML='<p hidden>Secret match</p><p>Visible match</p>'");
    await expect(
      f.execute({ action: "wait_for", text: "Secret match", timeout: 1 }),
    ).rejects.toMatchObject({ code: "timeout" });
    await f.execute({ action: "wait_for", text: "Visible match" });
    await f.evaluate(
      "document.body.replaceChildren(...Array.from({length:1025},()=>document.createElement('span')))",
    );
    await expect(f.execute({ action: "wait_for", text: "absent" })).rejects.toMatchObject({
      code: "page_text_limit",
    });
  });
});
