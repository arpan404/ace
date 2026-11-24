// SPDX-License-Identifier: Apache-2.0
import type { SniListener, SniListenerOptions } from "./sni-listener.ts";
import { testSniListener } from "./sni-test-support.ts";

/** The gates a case sets to hold the bind or the close open, as a slow socket layer would. */
export interface DirectGates {
  bind?: Promise<void> | undefined;
  close?: Promise<void> | undefined;
}

/** One listener factory and what it made, so a case can see nothing opened later. */
export interface GatedDirectListener {
  /** `remoteDirect`'s listener factory, whichever backend the switch selects. */
  listener(options: SniListenerOptions): SniListener;
  /** Every listener the factory made. */
  made: SniListener[];
  /** Every port a bind settled with. */
  ports: number[];
}

/**
 * `remoteDirect`'s own listener, behind gates that hold its bind and its close, moved here so
 * `remote-direct.process.test.ts` runs both legs with the cases it always had (T1b.4).
 */
export function gatedDirectListener(
  gates: DirectGates,
  cleanups: (() => Promise<void> | void)[],
): GatedDirectListener {
  const made: SniListener[] = [];
  const ports: number[] = [];
  return {
    made,
    ports,
    listener: (options) => {
      const real = testSniListener(options);
      made.push(real);
      cleanups.push(() => real.close().catch(() => {}));
      return {
        http: real.http,
        async listen(host, port) {
          await gates.bind;
          const bound = await real.listen(host, port);
          ports.push(bound);
          return bound;
        },
        async close() {
          await gates.close;
          await real.close();
        },
        trust: (certificate) => real.trust?.(certificate),
      };
    },
  };
}
