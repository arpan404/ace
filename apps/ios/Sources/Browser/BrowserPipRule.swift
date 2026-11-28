import Foundation

/// Whether the thread's live page keeps showing in picture-in-picture, as web's `pip-rules.ts`
/// decides it. Pure.
///
/// The tab the person views floats while the Browser isn't on screen (they left it or the app),
/// as long as an agent browses (any tab in use) or that tab plays sound. Not for a closed, paused,
/// recovering or blank browser, nor once the person dismissed it (until the Browser shows again),
/// nor ever while they turned it off in Settings › Browser.
enum BrowserPipRule {
    /// Settings › Browser › Picture in picture, on this phone; on unless turned off.
    static let settingKey = "ace.browser.pip"

    static func shows(state: BrowserViewInfo.State?, showingBrowser: Bool, dismissed: Bool, enabled: Bool) -> Bool {
        guard enabled, !showingBrowser, !dismissed, let state, !state.closed else { return false }
        guard state.status != "paused", state.status != "recovering", state.blank != true else { return false }
        guard let shown = state.tabs.first(where: { $0.id == state.activeTabId }),
              !shown.url.isEmpty, shown.url != "about:blank" else { return false }
        let browsing = state.tabs.contains { $0.agent != nil }
        return browsing || state.shown?.audible == true
    }
}
