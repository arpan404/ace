/*
 * screen_display: pictures of whole displays, view only. The helper lists the displays and the
 * apps with windows on screen; apps computer use refuses are left out, and the helper pictures
 * only windows of the rest, so an app that shows up between the two requests stays out too.
 */
import { ComputerError, type ComputerClient } from "./client.ts";
import { blockedReason } from "./policy.ts";
import { ComputerDisplays } from "./wire.ts";

type Display = ComputerDisplays["displays"][number];
export type DisplayContent = (
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/jpeg" }
)[];

export interface DisplayLook {
  /** One display's number; every display when absent. */
  display?: number | undefined;
  /** The person's own list of apps agents can't use. */
  personBlocked: readonly string[];
  host?: NodeJS.Platform | undefined;
  signal: AbortSignal;
}

function describe(display: Display): string {
  return [
    `${display.index}. ${display.name || "Display"}`,
    `${display.width}×${display.height}`,
    ...(display.main ? ["main"] : []),
    ...(display.rotation ? [`rotated ${display.rotation}°`] : []),
  ].join(", ");
}

async function ask(
  client: ComputerClient,
  op: "displays" | "capture_displays",
  payload: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ComputerDisplays> {
  try {
    return ComputerDisplays.parse(await client.request(op, payload, { signal }));
  } catch (error) {
    // A helper from before display pictures does not know the op.
    if (error instanceof ComputerError && error.code === "bad_request")
      throw new ComputerError(
        "unavailable",
        "This machine's screen helper is too old to picture displays. Ask the person to update ace there.",
      );
    throw error;
  }
}

export async function lookAtDisplays(
  client: ComputerClient,
  look: DisplayLook,
): Promise<DisplayContent> {
  const listed = await ask(client, "displays", {}, look.signal);
  const wanted =
    look.display === undefined
      ? listed.displays
      : listed.displays.filter((display) => display.index === look.display);
  if (!wanted.length)
    throw new ComputerError(
      "display_not_found",
      look.display === undefined
        ? "macOS reports no displays."
        : `There is no display ${look.display}. Displays:\n${listed.displays.map(describe).join("\n")}`,
    );
  const hidden = listed.apps.filter((app) => blockedReason(app, look.personBlocked, look.host));
  const include = listed.apps.filter((app) => !hidden.includes(app)).map((app) => app.bundleId);
  const captured = await ask(
    client,
    "capture_displays",
    { displays: wanted.map((display) => display.index), include },
    look.signal,
  );
  const lines = captured.displays.map((display) =>
    display.screenshot
      ? describe(display)
      : `${describe(display)}: no picture. ${display.screenshotError ?? "macOS returned none."}`,
  );
  const names = [...new Set(hidden.map((app) => app.name || app.bundleId))];
  const text = [
    `Displays:\n${lines.join("\n")}`,
    ...(names.length
      ? [`Left out of the pictures, as apps computer use refuses: ${names.join(", ")}.`]
      : []),
    "The pictures are view only. To act in an app, use screen_state.",
  ].join("\n\n");
  return [
    { type: "text", text },
    ...captured.displays.flatMap((display) =>
      display.screenshot
        ? [
            {
              type: "image" as const,
              data: display.screenshot.jpeg,
              mimeType: "image/jpeg" as const,
            },
          ]
        : [],
    ),
  ];
}
