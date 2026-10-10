import { Component, type ReactNode } from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { IconButton } from "./icon-button.tsx";
import { useToast } from "./toast.tsx";

interface Props {
  label: string;
  children: ReactNode;
  fallback?: ReactNode;
  report(retry: () => void): void;
}

class Boundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  retry = () => this.setState({ failed: false });
  override componentDidCatch() {
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

/** Keep a broken region recoverable without unmounting its neighbours. */
export function LocalBoundary(props: Omit<Props, "report">) {
  const toast = useToast();
  return (
    <Boundary
      {...props}
      report={(retry) =>
        toast.error({
          title: `Couldn't show ${props.label}`,
          actionProps: { children: "Try again", onClick: retry },
        })
      }
    />
  );
}
