#if ACE_FIXTURE
import SwiftUI
import UIKit
import WebKit

/// A device tab's page through the app's own path (ADR 0194), in fixture builds only: the tab's
/// web view made and kept by `DeviceTabsModel` and shown by `DevicePageView`, as the browser
/// shows it, then taken off screen by showing another tab and shown again.
extension PageRulesRun {
    /// When the framed page is asked to reach the machine.
    enum TabStage: String, CaseIterable, Sendable {
        case shown, otherTabShown = "other-tab-shown", shownAgain = "shown-again"
    }

    /// A localhost page framing an `origin` page, opened in a device tab. At each stage the
    /// framed page is asked to load localhost in a frame of its own; it reports each attempt to
    /// the public site first. Returns the stages whose load reached the machine and the stages
    /// the framed page reported trying.
    func runInDeviceTab(framing origin: PageRulesScenario.Origin) async -> (reached: [String], tried: [String]) {
        let id = "device-tab-\(origin == .publicSite ? "public" : "localhost")-frame"
        let machineBase = "http://localhost:\(machinePort)"
        let hit = "/hit/\(id)"
        let own = origin == .publicSite ? publicBase : machineBase
        book.put("/page/\(id)", "<iframe src='\(own)/inner/\(id)'></iframe>")
        book.put("/inner/\(id)", """
            <script>
            addEventListener('message', (event) => {
              fetch('\(publicBase)/ran/\(id)/' + event.data, { mode: 'no-cors', keepalive: true }).catch(() => {});
              const frame = document.createElement('iframe');
              frame.src = '\(machineBase)\(hit)?' + event.data;
              document.body.appendChild(frame);
            });
            </script>
            """)
        let model = ClientModel(now: { 0 })
        let tab = DeviceTabsPatch.Tab(id: id, url: "\(machineBase)/page/\(id)", title: "", load: 1, ready: true, problem: nil)
        let other = DeviceTabsPatch.Tab(id: "\(id)-other", url: "about:blank", title: "", load: 0, ready: true, problem: nil)
        model.deviceTabs.apply(DeviceTabsPatch(tabs: [tab, other], holding: true, listening: [machinePort], refused: nil))
        let host = UIHostingController(rootView: AnyView(ShownTab(model: model, tab: tab)))
        host.view.frame = CGRect(x: 0, y: 0, width: 320, height: 480)
        window?.addSubview(host.view)
        defer {
            model.deviceTabs.existingView(id)?.stopLoading()
            host.view.removeFromSuperview()
        }
        // The page and its frame load once the rules are on.
        try? await Task.sleep(for: .milliseconds(1500))
        for stage in TabStage.allCases {
            switch stage {
            case .shown: break
            // As the browser does: the tab's view goes with its id, and a new one comes back.
            case .otherTabShown: host.rootView = AnyView(ShownTab(model: model, tab: other))
            case .shownAgain: host.rootView = AnyView(ShownTab(model: model, tab: tab))
            }
            try? await Task.sleep(for: .milliseconds(300))
            _ = try? await model.deviceTabs.existingView(id)?.evaluateJavaScript("frames[0].postMessage('\(stage.rawValue)', '*')")
            try? await Task.sleep(for: .milliseconds(1500))
        }
        let reached = TabStage.allCases.map(\.rawValue).filter { stage in
            machine.seen.all.contains { $0.path == "\(hit)?\(stage)" }
        }
        let tried = TabStage.allCases.map(\.rawValue).filter { publicSite.seen.first(path: "/ran/\(id)/\($0)") != nil }
        return (reached, tried)
    }
}

/// One device tab on screen, as the browser shows it: its view is the tab's for as long as the
/// tab is shown.
private struct ShownTab: View {
    let model: ClientModel
    let tab: DeviceTabsPatch.Tab
    var body: some View {
        DevicePageView(model: model, tab: tab).id(tab.id)
    }
}
#endif
