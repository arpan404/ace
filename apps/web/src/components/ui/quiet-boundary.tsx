import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  retryWhen: boolean;
}

/**
 * For a popup that only describes something (a tooltip): if it fails to draw it is left out,
 * with nothing in its place, and it tries again when `retryWhen` next turns true (it reopens).
 */
export class QuietBoundary extends Component<Props, { failed: boolean; was: boolean }> {
  override state = { failed: false, was: this.props.retryWhen };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(props: Props, state: { failed: boolean; was: boolean }) {
    const again = state.failed && props.retryWhen && !state.was;
    return { failed: again ? false : state.failed, was: props.retryWhen };
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}
