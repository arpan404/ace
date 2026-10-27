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
                Button("Find in page", ace: .fileMagnifyingGlass) { finding = true }
                    .disabled(!page)
                Menu {
                    Button("Zoom in", ace: .magnifyingGlassPlus) { model.browserZoom("in") }
                    Button("Zoom out", ace: .magnifyingGlassMinus) { model.browserZoom("out") }
                    Button("Actual size", ace: .magnifyingGlass) { model.browserZoom("reset") }
                        .disabled(state?.shown?.zoom == nil)
                } label: {
                    Label("Zoom\(state?.shown?.zoom.map { " · \($0)" } ?? "")", ace: .magnifyingGlassPlus)
                }
                .disabled(!operate)
                Menu {
                    Button("Visible area") { screenshot(false) }
                    Button("Full page") { screenshot(true) }
                } label: {
                    Label("Take screenshot", ace: .camera)
                }
                .disabled(!operate || state?.shown?.private == true)
                if let device = model.browser.view?.device {
                    Button(device.toolbar ? "Hide device toolbar" : "Device · \(device.label)", ace: .deviceMobile) {
                        model.browserDeviceToolbar(!device.toolbar)
                    }
                    .disabled(!page)
                    .accessibilityIdentifier("browser.menu.device")
                }
                if let url {
                    ShareLink(item: url) { Label("Share address", ace: .export) }
                    Button("Copy address", ace: .copy) { UIPasteboard.general.url = url }
                }
            }
            Section {
                Button("History", ace: .clockCounterClockwise) { sheet = .history }
                Button(downloadsTitle, ace: .arrowCircleDown) { sheet = .downloads }
                    .disabled(state == nil)
                Button("Console", ace: .terminal) { sheet = .console }
                    .disabled(!page)
            }
            if model.canOperate, let tabId = state?.activeTabId, state?.closed == false {
                Section {
                    if state?.shown?.private == true {
                        Button("Hand back to agents", ace: .users) { model.browserTakeOver(tabId, false) }
                    } else {
                        Button("Take over", ace: .hand) { model.browserTakeOver(tabId, true) }
                    }
                    Button("New tab", ace: .plusSquare) { model.browserNewTab() }
                    Button("Close tab", ace: .xSquare, role: .destructive) { model.browserCloseTab(tabId) }
                }
            }
            Section {
                Button("Browser settings", ace: .gear) { sheet = .settings }
            }
        } label: {
            AceIcon(.dotsThree, size: 17, relativeTo: .subheadline)
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
