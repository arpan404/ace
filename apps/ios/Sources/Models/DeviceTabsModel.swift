import Foundation
import WebKit

/// What the bridge says about a machine's device tabs (`bridge/device-tabs.ts`).
struct DeviceTabsPatch: Decodable, Equatable, Sendable {
    struct Tab: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        let url: String
        let title: String
        /// Counts the loads the bridge asked for; the page loads `url` whenever it goes up.
        let load: Int
        /// The page's port is listened on (or known busy): its load may start.
        let ready: Bool
        /// Why the page can't reach the machine's port, as one sentence; nil when it can.
        let problem: String?
    }
    let tabs: [Tab]
    /// Whether this machine holds the phone's loopback ports.
    let holding: Bool
    let listening: [Int]
    /// Why the last typed address opened nothing (`parseAddress`'s reason).
    let refused: String?
}

/// A machine's device tabs on the phone (ADR 0194): pages the person opens, run in the phone's
/// own web view. The bridge keeps the tabs and decides the ports; this keeps the web views, so a
/// tab's page lives on while another tab is shown.
@MainActor @Observable final class DeviceTabsModel {
    private(set) var tabs: [DeviceTabsPatch.Tab] = []
    private(set) var holding = false
    private(set) var refused: String?
    /// The device tab shown in the browser instead of ace's Chrome; nil shows ace's Chrome.
    var shown: String?
    /// The browser is on screen and the app in front (`frontDeviceTab`, `hideDeviceTabs`).
    @ObservationIgnored var onScreen = false
    /// Each tab's live page, kept while the tab is open.
    @ObservationIgnored private var views: [String: WKWebView] = [:]
    /// The last load each tab's page ran (`Tab.load`).
    @ObservationIgnored private var loaded: [String: Int] = [:]
    /// Each tab's page as the bar shows it.
    @ObservationIgnored private var statuses: [String: DevicePageStatus] = [:]
    /// Set once a tab opens: it is shown as soon as the bridge names it.
    @ObservationIgnored private var showNext = false

    var shownTab: DeviceTabsPatch.Tab? { shown.flatMap { id in tabs.first { $0.id == id } } }

    /// Returns the tab just opened from this phone, to show it.
    @discardableResult func apply(_ patch: DeviceTabsPatch) -> String? {
        let before = Set(tabs.map(\.id))
        tabs = patch.tabs
        holding = patch.holding
        refused = patch.refused
        let ids = Set(patch.tabs.map(\.id))
        for id in views.keys where !ids.contains(id) { views.removeValue(forKey: id)?.stopLoading() }
        loaded = loaded.filter { ids.contains($0.key) }
        statuses = statuses.filter { ids.contains($0.key) }
        if let shown, !ids.contains(shown) { self.shown = nil }
        guard showNext, let added = patch.tabs.last(where: { !before.contains($0.id) }) else { return nil }
        showNext = false
        return added.id
    }

    /// The next tab the bridge opens is shown.
    func showOpened() { showNext = true }

    /// The tab's web view, made once for `hostId`'s data store.
    func view(for tab: DeviceTabsPatch.Tab, hostId: String) -> WKWebView {
        if let view = views[tab.id] { return view }
        let view = DevicePageEngine.webView(hostId: hostId)
        views[tab.id] = view
        return view
    }

    /// Whether the bridge asked for a load the tab's page hasn't run yet; true once per load.
    func takeLoad(_ tab: DeviceTabsPatch.Tab) -> Bool {
        guard tab.ready, tab.load > (loaded[tab.id] ?? 0) else { return false }
        loaded[tab.id] = tab.load
        return true
    }

    func status(_ id: String) -> DevicePageStatus {
        if let status = statuses[id] { return status }
        let status = DevicePageStatus()
        statuses[id] = status
        return status
    }

    /// The web view already made for a tab, if any.
    func existingView(_ id: String) -> WKWebView? { views[id] }

    /// The open tabs as a new runtime takes them (`restore`), each with the loads its page has
    /// already run, so none loads again.
    func restoreEntries() -> [[String: Any]] {
        tabs.map { tab in ["id": tab.id, "url": tab.url, "title": tab.title, "load": max(tab.load, loaded[tab.id] ?? 0)] }
    }

    func reset() {
        for view in views.values { view.stopLoading() }
        views.removeAll(); loaded.removeAll(); statuses.removeAll()
        tabs = []; holding = false; refused = nil; shown = nil
    }
}

/// One device tab's page as the bar draws it, from its web view.
@MainActor @Observable final class DevicePageStatus {
    var canGoBack = false
    var canGoForward = false
    var loading = false
    var url: URL?
    /// The loopback rules couldn't be made, so the page isn't loaded at all.
    var unsafe = false
    /// The last load failed before a page came; the next page clears it.
    var failed = false
    /// A public page tried to send a form to the machine's localhost and was stopped.
    var refused = false
}
