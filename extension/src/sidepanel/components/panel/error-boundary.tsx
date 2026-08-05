import { CircleAlertIcon } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

export function PanelFailure({
  detail,
  title,
}: {
  detail: string;
  title: string;
}) {
  return (
    <div className="flex h-full items-start justify-center bg-background p-4 text-foreground">
      <div
        className="panel-failure"
        role="alert"
      >
        <div className="panel-failure-heading">
          <CircleAlertIcon aria-hidden="true" />
          <span>{title}</span>
        </div>
        <p>{detail}</p>
      </div>
    </div>
  );
}

interface PanelErrorBoundaryProps {
  children: ReactNode;
}

interface PanelErrorBoundaryState {
  failed: boolean;
}

export class PanelErrorBoundary extends Component<
  PanelErrorBoundaryProps,
  PanelErrorBoundaryState
> {
  state: PanelErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): PanelErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The side panel has no other surface for a render failure, and the user
    // is being told to reopen it. Leave a trace for the DevTools console.
    console.error("TokenPath side panel failed to render.", error, info);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <PanelFailure
        detail="Close the side panel and open it again to start a fresh chat. Your saved chats are untouched."
        title="Something broke in this panel"
      />
    );
  }
}
