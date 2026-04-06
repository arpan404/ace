import { logLoadDiagnostic } from "../loadDiagnostics";

export function reportBackgroundError(message: string, error: unknown): void {
  logLoadDiagnostic({
    phase: "async",
    level: "warning",
    message,
    detail: error,
  });
  console.warn(message, error);
}

export function runAsyncTask(task: PromiseLike<unknown>, message: string): void {
  void Promise.resolve(task).catch((error: unknown) => {
    reportBackgroundError(message, error);
  });
}
