import { describe, expect, it } from "vitest";
import { executablePath, fixture, pixelPng } from "./test-support.ts";

const person = { kind: "human", connectionId: "person" } as const;

describe.skipIf(!executablePath)("ace's right-click menu over a page in ace's Chrome", () => {
  it("finds the link and image under a point, and hands over the image the page loaded", async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate(`new Promise((resolve) => {
      const link = document.createElement("a");
      link.href = "/data";
      link.style = "position:fixed;left:0;top:0";
      const image = document.createElement("img");
      image.src = "/pixel.png";
      image.width = 60;
      image.height = 60;
      image.onload = resolve;
      link.append(image);
      document.body.append(link);
    })`);
    const target = await f.service.execute(
      "thread",
      { action: "context_target", x: 20, y: 20 },
      person,
    );
    expect(target).toEqual({ link: `${f.url}/data`, image: `${f.url}/pixel.png` });
    // Away from them there is nothing to offer.
    expect(
      await f.service.execute("thread", { action: "context_target", x: 400, y: 400 }, person),
    ).toEqual({});

    const image = await f.service.execute(
      "thread",
      { action: "image_data", url: `${f.url}/pixel.png` },
      person,
    );
    expect(image).toEqual({ url: `${f.url}/pixel.png`, data: pixelPng.toString("base64") });
    // Only what the page loaded: any other address is refused, not fetched.
    await expect(
      f.service.execute(
        "thread",
        { action: "image_data", url: "https://example.invalid/a.png" },
        person,
      ),
    ).rejects.toThrow();
  }, 60_000);

  it("agents can't ask what is under the person's pointer", async () => {
    const f = await fixture();
    await f.navigate();
    await expect(f.execute({ action: "context_target", x: 1, y: 1 })).rejects.toThrow();
    await expect(f.execute({ action: "image_data", url: `${f.url}/pixel.png` })).rejects.toThrow();
  }, 60_000);
});
