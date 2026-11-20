import SwiftUI
import WebKit

/// A device tab's page in the phone's own web view (ADR 0194). The tab's web view and its
/// navigation delegate live in `DeviceTabsModel`, so switching tabs keeps each page where it was,
/// with its frame policy still on it while it is off screen. The bridge says when to load; the
/// page reports where it went.
struct DevicePageView: UIViewRepresentable {
    @Bindable var model: ClientModel
    let tab: DeviceTabsPatch.Tab

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .clear
        return container
    }

    func updateUIView(_ container: UIView, context: Context) {
        let hostId = model.hostId ?? ""
        let view = model.deviceTabs.view(for: tab, hostId: hostId)
        let status = model.deviceTabs.status(tab.id)
        if view.superview !== container {
            container.subviews.forEach { $0.removeFromSuperview() }
            view.frame = container.bounds
            view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            container.addSubview(view)
        }
        model.deviceTabs.watcher(tab.id)?.follow(view, report: { [weak model] id, url, title in
            model?.deviceTabPage(id, url: url, title: title)
        }, failed: { [weak model] id, url in
            model?.deviceTabFailed(id, url: url)
        })
        guard model.deviceTabs.takeLoad(tab), let url = URL(string: tab.url) else { return }
        // Nothing loads before the loopback rules are on the page: a public page must never
        // reach the machine's localhost through the phone's listeners, even once.
        let tabs = model.deviceTabs
        DevicePageEngine.loopbackRules { [weak view, weak tabs] rules in
            // The rules may come after the tab closed or a newer load began; this load is gone.
            guard let view, let tabs, tabs.stillLoads(tab, in: view) else { return }
            guard let rules else { status.unsafe = true; return }
            let content = view.configuration.userContentController
            content.remove(rules)
            content.add(rules)
            view.load(URLRequest(url: url))
        }
    }
}

/// One web view's navigation delegate, which holds its frame policy, and its watcher for the bar
/// and the bridge. A web view holds its delegate weakly, so whoever keeps the view keeps this
/// too (`DeviceTabsModel`, for a tab's page), never a SwiftUI coordinator that goes with the view
/// on screen. Key-value observations may arrive on any thread, so each is `@Sendable` and hops to
/// the main actor itself.
@MainActor final class DevicePageCoordinator: NSObject, WKNavigationDelegate {
    private var observations: [NSKeyValueObservation] = []
    private weak var watched: WKWebView?
    private let tab: String
    private let status: DevicePageStatus
    private var failed: (String, String) -> Void = { _, _ in }

    init(tab: String, status: DevicePageStatus) {
        self.tab = tab; self.status = status
    }

    /// Becomes `view`'s navigation delegate, before the view loads anything.
    func attach(_ view: WKWebView) { view.navigationDelegate = self }

    /// Reports where the page goes and what the bar shows; the policy is on from `attach`.
    func follow(_ view: WKWebView,
                report: @escaping @MainActor (String, String, String?) -> Void,
                failed: @escaping (String, String) -> Void) {
        self.failed = failed
        guard watched !== view else { return }
        watched = view
        let tab = tab, status = status
        observations.removeAll()
        let refresh: @Sendable (WKWebView) -> Void = { view in
            nonisolated(unsafe) let view = view
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    status.canGoBack = view.canGoBack
                    status.canGoForward = view.canGoForward
                    status.loading = view.isLoading
                    status.url = view.url
                }
            }
        }
        let moved: @Sendable (WKWebView) -> Void = { view in
            nonisolated(unsafe) let view = view
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let url = view.url?.absoluteString, !url.isEmpty else { return }
                    report(tab, url, view.title)
                }
            }
        }
        observations = [
            view.observe(\.url, options: [.new]) { @Sendable view, _ in refresh(view); moved(view) },
            view.observe(\.title, options: [.new]) { @Sendable view, _ in moved(view) },
            view.observe(\.isLoading, options: [.new]) { @Sendable view, _ in refresh(view) },
            view.observe(\.canGoBack, options: [.new]) { @Sendable view, _ in refresh(view) },
            view.observe(\.canGoForward, options: [.new]) { @Sendable view, _ in refresh(view) },
        ]
        refresh(view)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        status.failed = false; status.refused = false
    }

    /// Main-frame navigations to the machine's loopback follow `allowsMainFrame`, child frames
    /// follow `allowsSubframe`; subresources are the rule list's. Redirects come through here
    /// again with their method.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        // The source frame is the page on screen even for a load the app asked for (iOS 26), so
        // it can't tell the person's navigations from the page's, and nothing here tries to.
        // Read it so a missing one is nil, not a crash, though the header says it never is.
        let source = navigationAction.value(forKey: "sourceFrame") as? WKFrameInfo
        let url = navigationAction.request.url
        let allowed = navigationAction.targetFrame?.isMainFrame ?? true
            ? DevicePageEngine.allowsMainFrame(to: url, method: navigationAction.request.httpMethod,
                                               sourceHost: source?.securityOrigin.host)
            : DevicePageEngine.allowsSubframe(to: url, sourceHost: source?.securityOrigin.host)
        if !allowed { status.refused = true }
        decisionHandler(allowed ? .allow : .cancel)
    }

    /// The load never reached a page: the bridge words why when it was the machine's localhost.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        let error = error as NSError
        guard error.code != NSURLErrorCancelled else { return }
        status.failed = true
        if let url = error.userInfo[NSURLErrorFailingURLStringErrorKey] as? String { failed(tab, url) }
    }
}

/// The device tab's bottom bar, as the browser's: Back and Forward, the address (tap to type
/// another, which loads in this tab), the tabs and the tab's menu, each on glass.
struct DeviceTabBar: View {
    @Bindable var model: ClientModel
    let tab: DeviceTabsPatch.Tab
    @Binding var editing: Bool
    @Binding var sheet: BrowserSheet?

    private var status: DevicePageStatus { model.deviceTabs.status(tab.id) }
    private var view: WKWebView? { model.deviceTabs.existingView(tab.id) }
    private var count: Int { (model.browser.view?.state?.tabs.count ?? 0) + model.deviceTabs.tabs.count }

    var body: some View {
        HStack(spacing: AceDesign.Space.related) {
            HStack(spacing: AceTheme.Spacing.none) {
                barButton("Back", .caretLeft, enabled: status.canGoBack) { view?.goBack() }
                    .accessibilityIdentifier("device.back")
                barButton("Forward", .caretRight, enabled: status.canGoForward) { view?.goForward() }
                    .accessibilityIdentifier("device.forward")
            }
            .aceGlass(in: AceDesign.Shape.control, interactive: true)
            HStack(spacing: AceDesign.Space.tight) {
                Button { editing = model.canOperate } label: {
                    HStack(spacing: AceDesign.Space.tight) {
                        if status.loading { WorkingMark(label: "Loading") }
                        Text(address)
                            .foregroundStyle(address == Self.prompt ? AceDesign.Ink.muted : AceDesign.Ink.primary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    .font(AceDesign.Typeface.body).fontWeight(.regular)
                    .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap)
                    .padding(.leading, AceDesign.Space.row)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Address")
                .accessibilityValue(address)
                .accessibilityIdentifier("device.address")
                if status.loading {
                    barButton("Stop", .x, enabled: true) { view?.stopLoading() }
                } else {
                    barButton("Reload", .arrowClockwise, enabled: view != nil) { view?.reload() }
                        .accessibilityIdentifier("device.reload")
                }
            }
            .aceGlass(in: AceDesign.Shape.control, interactive: true)
            HStack(spacing: AceTheme.Spacing.none) {
                Button { sheet = .tabs } label: {
                    TabCount(count: count)
                        .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Tabs")
                .accessibilityValue("\(count)")
                .accessibilityIdentifier("device.tabs")
                menu
            }
            .aceGlass(in: AceDesign.Shape.control, interactive: true)
        }
        .padding(.horizontal, AceDesign.Space.row)
        .padding(.top, AceDesign.Space.related)
        .padding(.bottom, AceDesign.Space.tight)
    }

    private var menu: some View {
        Menu {
            Section("On this phone") {
                if let url = status.url ?? URL(string: tab.url) {
                    ShareLink(item: url) { Label("Share address", ace: .export) }
                    Button("Copy address", ace: .copy) { UIPasteboard.general.url = url }
                }
                if model.browser.view?.state?.tabs.isEmpty == false {
                    Button("Show ace's Chrome", ace: .browsers) { model.showChrome() }
                }
                Button("Close tab", ace: .xSquare, role: .destructive) { model.closeDeviceTab(tab.id) }
            }
        } label: {
            AceIcon(.dotsThree, size: AceDesign.Size.barIcon, relativeTo: .subheadline)
                .foregroundStyle(AceDesign.Ink.primary)
                .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Tab options")
        .accessibilityIdentifier("device.menu")
    }

    private static let prompt = "Search or enter address"
    private var address: String {
        // Until a page commits (or after one failed), the address is the one asked for.
        let current = status.url?.absoluteString
        let text = current == nil || current == "about:blank" || status.failed ? tab.url : current ?? tab.url
        guard !text.isEmpty, text != "about:blank", let url = URL(string: text) else { return Self.prompt }
        guard let host = url.host(percentEncoded: false) else { return text }
        return url.port.map { "\(host):\($0)" } ?? host
    }

    private func barButton(_ label: String, _ icon: AceIcon.Name, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            AceIcon(icon, size: AceDesign.Size.barIcon, relativeTo: .subheadline)
                .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(enabled ? AceDesign.Ink.primary : AceDesign.Ink.faint)
        .disabled(!enabled)
        .accessibilityLabel(label)
    }
}
