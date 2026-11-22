import { useLocation, useNavigate } from "@tanstack/react-router";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs.tsx";

/**
 * Fleet's two views as the app's page tabs: Overview (the rows) and Map (the network diagram).
 * Each is its own address, so Back and a shared link land on the same view.
 */
export function FleetTabs() {
  const map = useLocation({ select: (location) => location.pathname.endsWith("/map") });
  const navigate = useNavigate();
  return (
    <div className="border-b border-border pt-4 pb-2">
      <Tabs
        value={map ? "map" : "overview"}
        onValueChange={(value) => {
          if (typeof value !== "string") return;
          void navigate({ to: value === "map" ? "/settings/remote/map" : "/settings/remote" });
        }}
      >
        <TabsList aria-label="Fleet views">
          <TabsTab value="overview" page>
            Overview
          </TabsTab>
          <TabsTab value="map" page>
            Map
          </TabsTab>
        </TabsList>
      </Tabs>
    </div>
  );
}
