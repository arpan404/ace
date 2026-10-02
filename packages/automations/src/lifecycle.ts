/** Stop owns teardown; callback-driven start cannot acquire resources inside it. */
export class Lifecycle {
  private phase: "stopped" | "starting" | "live" | "stopping" = "stopped";
  private stopRequested = false;
  get live(): boolean {
    return !this.stopRequested && (this.phase === "starting" || this.phase === "live");
  }
  beginStart(): boolean {
    if (this.phase !== "stopped") return false;
    this.phase = "starting";
    return true;
  }
  /** Startup owns resources until it finishes, then performs any requested stop. */
  endStart(): boolean {
    this.phase = "live";
    return this.stopRequested;
  }
  beginStop(): boolean {
    if (this.phase === "starting") {
      this.stopRequested = true;
      return false;
    }
    if (this.phase === "stopping") return false;
    this.phase = "stopping";
    return true;
  }
  endStop(): void {
    this.phase = "stopped";
    this.stopRequested = false;
  }
}
