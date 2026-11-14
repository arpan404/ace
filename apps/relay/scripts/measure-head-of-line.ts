/**
 * How long an approval-sized message waits behind a snapshot on a slow link through a relay
 * (ADR 0110), with and without lanes. A local relay, a shaped TCP link in front of the phone's
 * socket, credit flow control on; prints one line per case. Local only.
 *
 *   bun apps/relay/scripts/measure-head-of-line.ts [snapshot KiB] [kbit/s] [round trip ms]
 */
import { measureHeadOfLine } from "../src/testing/head-of-line.ts";

const snapshotKib = Number(process.argv[2] ?? 1024);
const kbit = Number(process.argv[3] ?? 400);
const roundTripMs = Number(process.argv[4] ?? 400);
const link = { bytesPerSecond: (kbit * 1000) / 8, roundTripMs };
for (const lanes of [false, true]) {
  const result = await measureHeadOfLine({
    link,
    lanes,
    snapshotBytes: snapshotKib * 1024,
    afterMs: Number(process.env.AFTER_MS ?? 500),
  });
  console.log(
    `${lanes ? "lanes   " : "no lanes"}  approval ${result.approvalMs} ms  snapshot ${result.snapshotMs} ms` +
      `  overtook ${result.overtook}  intact ${result.intact}`,
  );
}
process.exit(0);
