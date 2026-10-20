import { maxHtmlDocumentBytes, maxMessageBytes, maxSharedImageDataChars } from "@ace/protocol";

/** Validated result JSON excludes the transport envelope and SSE framing. */
export const maxStructuredResultBytes = 256 * 1024;
export const maxRichResultBytes = 12 * 1024 * 1024;
export const maxModelImageBytes = 1024 * 1024;
export const maxBridgeResponseBytes = maxRichResultBytes + 64 * 1024;
export const maxBridgeQueuedBytes = 32 * 1024 * 1024;
/** One agent-control call: a message as long as a person's, plus the call's other fields. */
export const maxControlInputBytes = maxMessageBytes + 64 * 1024;
/** delegate starts up to eight children in one call, each with a message-sized task. */
export const maxBatchInputBytes = 8 * maxControlInputBytes;
/** html_render's page as JSON: base64 images need no escaping, markup quotes a little. */
export const maxHtmlInputBytes = maxHtmlDocumentBytes + 4 * 1024 * 1024;
/** image_show's base64 image plus its other fields. */
export const maxImageInputBytes = maxSharedImageDataChars + 16 * 1024;
/**
 * The largest tool call the HTTP endpoint and the stdio bridge admit. Each tool still enforces
 * its own input budget after parsing (64 KiB unless it declares more).
 */
export const maxRequestBodyBytes =
  Math.max(maxBatchInputBytes, maxImageInputBytes, maxHtmlInputBytes) + 64 * 1024;
