import { InteractionRequest, type CoreServerMessage } from "@ace/protocol";
import { ClientError } from "./errors.ts";

/** One page of a request's JSON (`interaction.data`). */
export type InteractionData = Extract<CoreServerMessage, { type: "interaction.data" }>;

/** Which request to read: one its thread sends only summarized (`truncated`, ADR 0157). */
export interface WholeRequestInput {
  threadId: string;
  interactionId: string;
}

/** A request read whole, and the `version` it read under, which an answer to it echoes. */
export interface ReadRequest {
  request: InteractionRequest;
  version: string;
}

/** How many times a read starts again because the request changed while it was read. */
const mostRestarts = 3;

/**
 * `page` checked against the read that asked for it: the same request, from `offset`, its text
 * exactly the span it names, and only an empty last page.
 */
export function checkedPage(
  input: WholeRequestInput,
  offset: number,
  page: InteractionData,
): InteractionData {
  if (
    page.threadId !== input.threadId ||
    page.interactionId !== input.interactionId ||
    page.offset !== offset ||
    page.nextOffset !== offset + page.text.length ||
    page.nextOffset > page.total ||
    page.eof !== (page.nextOffset === page.total) ||
    (!page.eof && !page.text.length)
  )
    throw new ClientError("protocol", "Unexpected request page");
  return page;
}

/**
 * The whole request, read through `page` from offset 0 to its end. Pages from another version
 * (the request was replaced meanwhile) start the read again, at most `mostRestarts` times; then
 * it fails as `stale`. Text that isn't a request fails as `protocol`.
 */
export async function readWholeRequest(
  page: (offset: number) => Promise<InteractionData>,
): Promise<ReadRequest> {
  for (let restarts = 0; restarts <= mostRestarts; restarts++) {
    const read = await readOneVersion(page);
    if (read !== undefined) return { request: parsedRequest(read.text), version: read.version };
  }
  throw new ClientError("stale", "The request kept changing while it was read");
}

/** The joined text of one version of the request, or undefined when it changed midway. */
async function readOneVersion(
  page: (offset: number) => Promise<InteractionData>,
): Promise<{ text: string; version: string } | undefined> {
  const first = await page(0);
  const parts = [first.text];
  let last = first;
  while (!last.eof) {
    const next = await page(last.nextOffset);
    if (next.version !== first.version) return undefined;
    if (next.total !== first.total) throw new ClientError("protocol", "Request length changed");
    parts.push(next.text);
    last = next;
  }
  return { text: parts.join(""), version: first.version };
}

function parsedRequest(text: string): InteractionRequest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ClientError("protocol", "The request isn't JSON");
  }
  const parsed = InteractionRequest.safeParse(value);
  if (!parsed.success) throw new ClientError("protocol", "The request isn't one this client reads");
  return parsed.data;
}
