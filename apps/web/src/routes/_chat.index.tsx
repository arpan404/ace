import { createFileRoute } from "@tanstack/react-router";

import { NewThreadLanding } from "../components/chat/NewThreadLanding";
import { SidebarInset } from "../components/ui/sidebar";

function ChatIndexRouteView() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <NewThreadLanding />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
