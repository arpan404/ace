import { z } from "zod";
import type { BrowserCommand } from "@ace/protocol";
import { BrowserActionError } from "./action-error.ts";
import type { BrowserBackendPage } from "./backend.ts";
import type { Actor } from "./session-options.ts";

type ContextCommand = Extract<BrowserCommand, { action: "context_target" | "image_data" }>;

/** The largest image a person copies or saves from a page's context menu. */
export const imageDataLimit = 16 * 1024 * 1024;

const web = (value: string) => /^https?:\/\//i.test(value);
const Target = z.object({
  link: z.string().max(8192).optional(),
  image: z.string().max(8192).optional(),
});
const Evaluated = z.object({ result: z.object({ value: z.unknown() }) });
const FrameTree = z.object({ frameTree: z.object({ frame: z.object({ id: z.string() }) }) });
const Resource = z.object({ content: z.string(), base64Encoded: z.boolean() });

/** What sits under a point of the page: the link it is in and the image it is, if any. */
async function contextTarget(page: BrowserBackendPage, x: number, y: number) {
  // Only numbers are written into the expression; what it returns is checked before use.
  const expression = `(() => {
    const element = document.elementFromPoint(${x}, ${y});
    if (!element) return {};
    const link = element.closest("a[href]");
    const image = element.closest("img");
    return {
      link: link ? String(link.href) : undefined,
      image: image ? String(image.currentSrc || image.src) : undefined,
    };
  })()`;
  const evaluated = Evaluated.parse(
    await page.cdp.send("Runtime.evaluate", { expression, returnByValue: true }),
  );
  const target = Target.safeParse(evaluated.result.value);
  if (!target.success) return {};
  const { link, image } = target.data;
  return {
    ...(link && web(link) ? { link } : {}),
    ...(image && (web(image) || image.startsWith("data:image/")) ? { image } : {}),
  };
}

/**
 * An image the page already loaded, from Chrome's resource cache (no new request, and only
 * what this page shows): its bytes for the person to copy or save.
 */
async function imageData(page: BrowserBackendPage, url: string) {
  const { frame } = FrameTree.parse(await page.cdp.send("Page.getFrameTree")).frameTree;
  let resource: z.infer<typeof Resource>;
  try {
    resource = Resource.parse(
      await page.cdp.send("Page.getResourceContent", { frameId: frame.id, url }),
    );
  } catch {
    throw new BrowserActionError("not_found");
  }
  const data = resource.base64Encoded
    ? resource.content
    : Buffer.from(resource.content, "utf8").toString("base64");
  if ((data.length * 3) / 4 > imageDataLimit) throw new BrowserActionError("limit");
  return { url, data };
}

/** The page's right-click menu, drawn by ace over the screencast. The person's only. */
export async function executeContextCommand(
  command: ContextCommand,
  actor: Actor,
  page: BrowserBackendPage,
  read: () => void,
): Promise<unknown> {
  if (actor.kind !== "human") throw new BrowserActionError("invalid_arguments");
  read();
  return command.action === "context_target"
    ? contextTarget(page, command.x, command.y)
    : imageData(page, command.url);
}
