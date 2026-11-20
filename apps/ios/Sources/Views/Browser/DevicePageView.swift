import SwiftUI
import WebKit

/// A device tab's page in the phone's own web view (ADR 0194). The tab's web view lives in
/// `DeviceTabsModel`, so switching tabs keeps each page where it was. The bridge says when to
/// load; the page reports where it went.
struct DevicePageView: UIViewRepresentable {
    @Bindable var model: ClientModel
    let tab: DeviceTabsPatch.Tab

    func makeCoordinator() -> DevicePageCoordinator { DevicePageCoordinator() }

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
        context.coordinator.follow(view, tab: tab.id, status: status) { [weak model] id, url, title in
            model?.deviceTabPage(id, url: url, title: title)
        }
        guard model.deviceTabs.takeLoad(tab), let url = URL(string: tab.url) else { return }
        // Nothing loads before the loopback rules are on the page: a public page must never
        // reach the machine's localhost through the phone's listeners, even once.
        DevicePageEngine.loopbackRules { [weak view] rules in
            guard let view else { return }
            guard let rules else { status.unsafe = true; return }
            let content = view.configuration.userContentController
            content.remove(rules)
            content.add(rules)
            view.load(URLRequest(url: url))
        }
    }
}

/// Watches one web view for the bar and the bridge. Key-value observations may arrive on any
/// thread, so each hops to the main actor itself.
final class DevicePageCoordinator: NSObject {
    private var observations: [NSKeyValueObservation] = []
    private weak var watched: WKWebView?

    @MainActor func follow(_ view: WKWebView, tab: String, status: DevicePageStatus,
                           report: @escaping @MainActor (String, String, String?) -> Void) {
        guard watched !== view else { return }
        watched = view
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
            view.observe(\.url, options: [.new]) { view, _ in refresh(view); moved(view) },
            view.observe(\.title, options: [.new]) { view, _ in moved(view) },
            view.observe(\.isLoading, options: [.new]) { view, _ in refresh(view) },
            view.observe(\.canGoBack, options: [.new]) { view, _ in refresh(view) },
            view.observe(\.canGoForward, options: [.new]) { view, _ in refresh(view) },
        ]
        refresh(view)
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
        let text = status.url?.absoluteString ?? tab.url
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
