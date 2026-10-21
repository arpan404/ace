import SwiftUI
import UIKit

/// The browser's ⋯ menu, grouped as Safari's: the page (find, zoom, screenshot, share), the
/// thread's browser (history, downloads, console), the tab (keep agents out, close) and the
/// browser's settings. Everything acts on the tab shown.
struct BrowserMenu: View {
    @Bindable var model: ClientModel
    @Binding var sheet: BrowserSheet?
    @Binding var finding: Bool
    let screenshot: (Bool) -> Void

    private var state: BrowserViewInfo.State? { model.browser.view?.state }
    private var page: Bool { state.map { !$0.closed && $0.blank != true && $0.activeTabId != nil } ?? false }
    private var operate: Bool { model.canOperate && page }
    private var url: URL? { state?.addressUrl.flatMap { $0.isEmpty ? nil : URL(string: $0) } }

    var body: some View {
        Menu {
            Section {
                Button("Find in page", systemImage: "doc.text.magnifyingglass") { finding = true }
                    .disabled(!page)
                Menu("Zoom\(state?.shown?.zoom.map { " · \($0)" } ?? "")", systemImage: "plus.magnifyingglass") {
                    Button("Zoom in", systemImage: "plus.magnifyingglass") { model.browserZoom("in") }
                    Button("Zoom out", systemImage: "minus.magnifyingglass") { model.browserZoom("out") }
                    Button("Actual size", systemImage: "1.magnifyingglass") { model.browserZoom("reset") }
                        .disabled(state?.shown?.zoom == nil)
                }
                .disabled(!operate)
                Menu("Take screenshot", systemImage: "camera") {
                    Button("Visible area") { screenshot(false) }
                    Button("Full page") { screenshot(true) }
                }
                .disabled(!operate || state?.shown?.private == true)
                if let url {
                    ShareLink(item: url) { Label("Share address", systemImage: "square.and.arrow.up") }
                    Button("Copy address", systemImage: "doc.on.doc") { UIPasteboard.general.url = url }
                }
            }
            Section {
                Button("History", systemImage: "clock.arrow.circlepath") { sheet = .history }
                Button(downloadsTitle, systemImage: "arrow.down.circle") { sheet = .downloads }
                    .disabled(state == nil)
                Button("Console", systemImage: "terminal") { sheet = .console }
                    .disabled(!page)
            }
            if model.canOperate, let tabId = state?.activeTabId, state?.closed == false {
                Section {
                    if state?.shown?.private == true {
                        Button("Hand back to agents", systemImage: "person.2") { model.browserTakeOver(tabId, false) }
                    } else {
                        Button("Take over", systemImage: "hand.raised") { model.browserTakeOver(tabId, true) }
                    }
                    Button("New tab", systemImage: "plus.square.on.square") { model.browserNewTab() }
                    Button("Close tab", systemImage: "xmark.square", role: .destructive) { model.browserCloseTab(tabId) }
                }
            }
            Section {
                Button("Browser settings", systemImage: "gearshape") { sheet = .settings }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(AceTheme.Colours.foreground)
                .frame(width: AceTheme.Dimensions.touchTarget, height: AceTheme.Dimensions.touchTarget)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Browser options")
        .accessibilityIdentifier("browser.menu")
    }

    private var downloadsTitle: String {
        let downloading = state?.downloading ?? 0
        if downloading > 0 { return "Downloads · \(downloading) downloading" }
        let count = state?.downloads?.count ?? 0
        return count > 0 ? "Downloads · \(count)" : "Downloads"
    }
}
