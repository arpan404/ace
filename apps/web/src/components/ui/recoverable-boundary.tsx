import { Component, type ReactNode } from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { IconButton } from "./icon-button.tsx";
import { DeferredLoadError } from "@/lib/deferred-component.tsx";

interface Props {
  label: string;
  children: ReactNode;
  fallback?: ReactNode;
  report(retry: () => void): void;
  /** Called once it fails, for a region that must also close what opened it. */
  onFailed?: (() => void) | undefined;
  /** When this turns true after a failure, it tries again (the person reopened what failed). */
  retryWhen?: boolean | undefined;
}

export class RecoverableBoundary extends Component<Props, { failed: boolean }> {
  private error: unknown;
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  retry = () => {
    if (this.error instanceof DeferredLoadError) this.error.retry();
    this.error = undefined;
    this.setState({ failed: false });
  };
  override componentDidCatch(error: unknown) {
    this.error = error;
    this.props.report(this.retry);
    this.props.onFailed?.();
  }
  override componentDidUpdate(previous: Props) {
    if (this.state.failed && this.props.retryWhen && !previous.retryWhen) this.retry();
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <div
        role="alert"
        className="flex min-h-8 items-center gap-2 px-3 text-sm text-muted-foreground"
      >
        Couldn't show {this.props.label}.
        <IconButton icon={ArrowClockwiseIcon} label="Try again" size="sm" onClick={this.retry} />
      </div>
    );
  }
}
