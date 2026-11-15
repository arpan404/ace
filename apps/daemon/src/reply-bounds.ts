/*
 * How much one paged reply on the main channel may put ahead of an urgent message (an
 * approval, a Stop's acknowledgement, a send's receipt).
 *
 * The outbox sends a reply whole before anything queued behind it, and what it has written sits
 * in the socket and the link until it is delivered, so the largest reply a client can ask for
 * sets the worst wait. The bound is about bytes on the link: about 22 KB, which on 3g-slow
 * (400 kbit/s, 50 KB a second, 400 ms round trip) is about one more round trip.
 * `apps/daemon/bench/head-of-line.ts` measures it.
 */

/**
 * The JSON a page of raw payloads (`item.raw`) may carry. Transcript JSON deflates about 3×, so
 * a full page is about 22 KB on the link. It cannot be smaller than one stored entry: storage
 * keeps an entry's data inline up to 64 KiB, and a page sends such an entry whole.
 */
export const pageReplyBytes = 64 * 1024;

/**
 * Output bytes one `output.read` returns. They go as base64, which barely deflates, so a read is
 * sized by what it puts on the link: 16 KiB of output is about 22 KiB of JSON, about one raw
 * page's worth on the link. Even, so a UTF-16 text stream's reads end on a code unit.
 */
export const outputReadBytes = 16 * 1024;
