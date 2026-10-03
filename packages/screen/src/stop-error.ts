/** Stop can report a native command error after termination has been confirmed. */
export class ScreenStopError extends AggregateError {
  readonly captureTerminated: boolean;
  constructor(errors: readonly unknown[], captureTerminated: boolean) {
    super(
      errors,
      errors
        .map((error) => (error instanceof Error ? error.message : "Screen stop failed"))
        .join("; "),
    );
    this.captureTerminated = captureTerminated;
  }
}
