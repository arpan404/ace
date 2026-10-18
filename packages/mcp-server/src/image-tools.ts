import { z } from "zod";
import { ImageShowInput, ItemId, type McpAttribution } from "@ace/protocol";
import { PublicToolError } from "./public-error.ts";
import { maxImageInputBytes } from "./result-budgets.ts";
import type { Toolkit } from "./toolkits.ts";

export interface ImagePublicationPort {
  publish(
    caller: McpAttribution,
    input: ImageShowInput,
    signal: AbortSignal,
  ): Promise<{ itemId: string }>;
}
const { path, data, mimeType, alt, caption } = ImageShowInput.shape;
const ShowInput = ImageShowInput.extend({
  path: path.describe(
    "An image file on this machine, absolute or relative to your working directory.",
  ),
  data: data.describe("The image as base64 (no data: prefix), up to 16 MiB decoded."),
  mimeType: mimeType.describe("The type of data. ace checks the bytes either way."),
  alt: alt.describe("What the image shows, for people who cannot see it."),
  caption: caption.describe("A short line shown under the image."),
});
export const imageToolCatalog = [
  {
    name: "image_show",
    title: "Show an image inline",
    description:
      "Post an image into your reply: a screenshot, a rendered chart or diagram, a generated picture. Pass it as base64 data (up to 16 MiB), or a file path on this machine for larger files (up to 128 MiB). PNG, JPEG, WebP or GIF.",
    input: ShowInput,
    output: z.object({ itemId: ItemId }),
    capability: null,
    riskClass: "thread-write",
    toolset: "visualize",
    // Reading and storing a 128 MiB file takes a while.
    timeoutMs: 120000,
    // Base64 needs no JSON escaping; the request envelopes admit this (result-budgets.ts).
    maxInputBytes: maxImageInputBytes,
  },
] as const;
export function imageToolkit(port: ImagePublicationPort): Toolkit {
  return {
    register(registry) {
      registry.register({
        ...imageToolCatalog[0],
        async run(input, { caller, signal }) {
          if ((input.path === undefined) === (input.data === undefined))
            throw new PublicToolError(
              "invalid_arguments",
              undefined,
              undefined,
              undefined,
              undefined,
              [{ path: "path", expected: "exactly one of path or data" }],
            );
          return port.publish(caller, input, signal);
        },
      });
    },
  };
}
