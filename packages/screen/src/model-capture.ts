import { modelImage, PublicToolError, type ModelImageRuntime } from "@ace/mcp-server";
import { authorizeInput } from "./policy.ts";
import type { Frame } from "./frames.ts";
import type { Session } from "./session.ts";

export async function captureModelImage(
  session: Session,
  owner: string,
  capture: () => Promise<Frame>,
  signal: AbortSignal,
  runtime?: ModelImageRuntime,
) {
  const epoch = session.epoch;
  const frame = await capture();
  const image = await modelImage({ payload: frame.payload, ...frame.header }, signal, runtime);
  signal.throwIfAborted();
  authorizeInput(session, "agent", owner);
  if (epoch !== session.epoch) throw new PublicToolError("screenshot_required");
  session.modelCoordinates = {
    owner,
    epoch,
    sourceWidth: frame.header.width,
    sourceHeight: frame.header.height,
    width: image.width,
    height: image.height,
  };
  return image;
}
