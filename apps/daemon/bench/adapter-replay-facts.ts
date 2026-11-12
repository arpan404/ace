/**
 * Replays every recorded session through its provider's real translator and the core fold, with
 * frame data admitted by ProviderPayload (frozen, as live sessions deliver it), and prints a
 * digest of the facts, diagnostics and events per fixture. Run it in two checkouts and diff the
 * output to show a translator change leaves what is stored and sent identical:
 *
 *   bun apps/daemon/bench/adapter-replay-facts.ts > after.txt   # likewise in the base checkout
 *   bun apps/daemon/bench/adapter-replay-facts.ts --full        # the facts themselves, as JSON
 */
import { createHash } from "node:crypto";
import { apply, createThreadState } from "@ace/core";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { ThreadId } from "@ace/protocol";
import { recordedSessions, replayProviders } from "./adapter-replay-fixtures.ts";

const full = process.argv.includes("--full");
for (const [name, provider] of Object.entries(replayProviders))
  for (const session of await recordedSessions(provider)) {
    const threadId = ThreadId.parse(`replay-${name}`);
    const translator = provider.createTranslator({ threadId, rootKey: "root" });
    const state = createThreadState({
      threadId,
      config: { provider: provider.provider, silenceMs: provider.silenceMs },
    });
    let id = 0;
    const ids = { next: (kind: string) => `${kind}-${++id}` };
    const out: unknown[] = [];
    const fold = (facts: ReturnType<typeof translator.translate>, t: number) => {
      out.push({ facts });
      for (const fact of facts) out.push({ events: apply(state, fact, { now: t, ids }) });
    };
    for (const [seq, frame] of session.frames.entries()) {
      const payload = new ProviderPayload(frame.wire);
      fold(
        translator.translate(
          { seq, t: frame.t, dir: frame.dir, channel: frame.channel, data: payload.data, payload },
          frame.t,
        ),
        frame.t,
      );
      out.push({ diagnostics: translator.takeDiagnostics?.() ?? [] });
      fold(translator.tick(frame.t), frame.t);
    }
    const text = JSON.stringify(out);
    process.stdout.write(
      full
        ? `${name}/${session.name} ${text}\n`
        : `${name}/${session.name} ${createHash("sha256").update(text).digest("hex")} ${text.length}\n`,
    );
  }
