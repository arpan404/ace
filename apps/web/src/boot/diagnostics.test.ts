import { expect, test } from "vitest";
import { diagnosticsReporter } from "./diagnostics.ts";

const event = { event: "client-worker.lost", data: { cause: "timeout", attempt: 0 } };

test("connection facts go to the desktop log when the bridge offers one", () => {
  const logged: unknown[] = [];
  const warned: unknown[] = [];
  const report = diagnosticsReporter(
    { ace: { diagnostics: { report: (value: unknown) => logged.push(value) } } },
    (message) => warned.push(message),
  );
  report(event);
  expect(logged).toEqual([event]);
  expect(warned).toEqual([]);
});

test("without the bridge, or with a broken one, connection facts go to the console", () => {
  const warned: unknown[] = [];
  const warn = (message: string, data?: unknown) => warned.push([message, data]);
  diagnosticsReporter({}, warn)(event);
  diagnosticsReporter({ ace: { settings: {} } }, warn)(event);
  diagnosticsReporter(
    {
      ace: {
        diagnostics: {
          report() {
            throw new Error("bridge gone");
          },
        },
      },
    },
    warn,
  )(event);
  expect(warned).toEqual([
    ["ace: client-worker.lost", event.data],
    ["ace: client-worker.lost", event.data],
    ["ace: client-worker.lost", event.data],
  ]);
});
