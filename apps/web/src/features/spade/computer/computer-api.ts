import { parseSpadeComputerBody, spadeBase64, type SpadeComputer } from "@ace/ui-core/spade-chat";
import { segment, spadeHttp, type SpadeTarget } from "../spade-requests.ts";

/*
 * A bot's computer (who drives it, take over, hand back), its terminal's input and size, and the
 * file manager's writes. Reads of files stay on the workspace routes (`spade-workspace-api.ts`).
 */

const base = (bot: string) => `/v1/agents/${segment(bot)}`;

export async function readComputer(
  target: SpadeTarget,
  bot: string,
  signal?: AbortSignal,
): Promise<SpadeComputer> {
  const body = await spadeHttp(target, "GET", `${base(bot)}/computer`, { signal });
  const computer = parseSpadeComputerBody(body);
  if (!computer) throw new Error("Spade's computer didn't make sense.");
  return computer;
}

/** The person drives: the bot pauses until the computer is handed back. */
export async function takeOver(target: SpadeTarget, bot: string): Promise<void> {
  await spadeHttp(target, "POST", `${base(bot)}/computer/take-over`);
}

export async function handBack(target: SpadeTarget, bot: string): Promise<void> {
  await spadeHttp(target, "POST", `${base(bot)}/computer/hand-back`);
}

/** Keys for the bot's terminal; Spade takes them only while the person drives. */
export async function typeInTerminal(target: SpadeTarget, bot: string, data: string) {
  const bytes = new TextEncoder().encode(data);
  await spadeHttp(target, "POST", `${base(bot)}/terminal/input`, {
    body: { data_b64: spadeBase64(bytes) },
  });
}

export async function resizeTerminal(target: SpadeTarget, bot: string, cols: number, rows: number) {
  await spadeHttp(target, "POST", `${base(bot)}/terminal/resize`, { body: { cols, rows } });
}

/** A text file saved as the person edited it. */
export async function saveFile(target: SpadeTarget, bot: string, path: string, text: string) {
  await spadeHttp(target, "PUT", `${base(bot)}/files?path=${encodeURIComponent(path)}`, {
    body: { text },
  });
}

/** A file from the person's computer, put at `path`. */
export async function uploadFile(
  target: SpadeTarget,
  bot: string,
  path: string,
  bytes: Uint8Array,
) {
  await spadeHttp(target, "POST", `${base(bot)}/files/upload`, {
    body: { path, data_b64: spadeBase64(bytes) },
  });
}

export async function makeFolder(target: SpadeTarget, bot: string, path: string) {
  await spadeHttp(target, "POST", `${base(bot)}/files/mkdir`, { body: { path } });
}

/** Renames or moves a file or folder; refused (409) when `to` exists. */
export async function movePath(target: SpadeTarget, bot: string, from: string, to: string) {
  await spadeHttp(target, "POST", `${base(bot)}/files/move`, { body: { from, to } });
}
