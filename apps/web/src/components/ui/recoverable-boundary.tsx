import { Component, type ReactNode } from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { IconButton } from "./icon-button.tsx";
import { DeferredLoadError } from "@/lib/deferred-component.tsx";

interface Props {
  label: string;
  children: ReactNode;
  fallback?: ReactNode;
  report(retry: () => void): void;
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
