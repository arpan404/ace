/*
 * How much one paged reply on the main channel may put ahead of an urgent message (an
 * approval, a Stop's acknowledgement, a send's receipt).
 *
 * The outbox sends a reply whole before anything queued behind it, so the largest reply a
 * client can ask for sets the worst wait. On 3g-slow (400 kbit/s, 400 ms round trip) a link
 * carries about 50 KB a second; 64 KiB of transcript JSON deflates to about 20 KiB, which is
 * about one more round trip. `apps/daemon/bench/head-of-line.ts` measures it.
 */

/** The JSON a page of raw payloads (`item.raw`) or of output (`output.read`) may carry. */
export const pageReplyBytes = 64 * 1024;

/**
 * Output bytes one `output.read` returns: base64 makes them 4/3 as long, so a full read is
 * `pageReplyBytes` of JSON. Even, so a UTF-16 text stream's reads end on a code unit.
 */
export const outputReadBytes = (pageReplyBytes / 4) * 3;
