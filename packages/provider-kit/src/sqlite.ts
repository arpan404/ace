// Node 24.13.0 gives node:sqlite's ExperimentalWarning no code. Keep Node's
// own output formatter for every other warning, and keep consumer listeners.
// Each SQLite worker isolate installs this filter before queued warnings print.
const defaultWarning = process
  .listeners("warning")
  .find((listener) => listener.name === "onWarning");
if (defaultWarning) {
  process.removeListener("warning", defaultWarning);
  process.on("warning", (warning) => {
    if (
      warning.name === "ExperimentalWarning" &&
      warning.message === "SQLite is an experimental feature and might change at any time" &&
      !("code" in warning)
    )
      return;
    defaultWarning.call(process, warning);
  });
}
export { DatabaseSync, StatementSync, backup } from "node:sqlite";
export type { SQLInputValue, SQLOutputValue } from "node:sqlite";
