import Foundation

/// A machine's device tabs (ADR 0194): pages the person opens run in the phone's own web view,
/// and the bridge (`bridge/device-tabs.ts`) carries their localhost to the machine.
extension ClientModel {
    /// Opens `address` (typed, or an agent tab's) in a new device tab and shows it.
    func openDeviceTab(_ address: String) {
        guard canOperate else { return }
        deviceTabs.showOpened()
        deviceTabAction(["kind": "open", "address": address])
    }
    /// Loads typed text in the shown device tab.
    func navigateDeviceTab(_ id: String, address: String) {
        guard canOperate else { return }
        deviceTabAction(["kind": "navigate", "tabId": id, "address": address])
    }
    func closeDeviceTab(_ id: String) {
        let wasShown = deviceTabs.shown == id
        if wasShown { deviceTabs.shown = nil }
        deviceTabAction(["kind": "close", "tabId": id])
        // The browser shows ace's Chrome now: no device page is on screen.
        if wasShown { deviceTabAction(["kind": "hidden"]) }
    }
    /// Shows a device tab in the browser; it takes the phone's loopback ports for this machine.
    func showDeviceTab(_ id: String) {
        deviceTabs.shown = id
        deviceTabAction(["kind": "front", "tabId": id])
    }
    /// The browser is on screen with the app in front: a shown device tab takes the ports again.
    func frontDeviceTab() {
        deviceTabs.onScreen = true
        guard let id = deviceTabs.shown else { return }
        deviceTabAction(["kind": "front", "tabId": id])
    }
    /// The browser left the screen, or the app went to the background: the phone's loopback
    /// ports and the connections on them go until a device tab is in front again.
    func hideDeviceTabs() {
        deviceTabs.onScreen = false
        deviceTabAction(["kind": "hidden"])
    }
    /// Shows ace's Chrome again; the device tabs stay open, their ports go.
    func showChrome() {
        guard deviceTabs.shown != nil else { return }
        deviceTabs.shown = nil
        deviceTabAction(["kind": "hidden"])
    }
    /// A new runtime on another route to the same machine: it takes the device tabs the phone
    /// still shows, so their pages stay where they are and the shown one takes the ports again.
    func restoreDeviceTabs() {
        guard !deviceTabs.tabs.isEmpty else { return }
        deviceTabAction(["kind": "restore", "tabs": deviceTabs.restoreEntries()])
        if deviceTabs.onScreen, let id = deviceTabs.shown { deviceTabAction(["kind": "front", "tabId": id]) }
    }
    /// Whether ace's Chrome has a page open in this thread; without one, a page the person opens
    /// runs on this phone.
    var chromeHasPage: Bool {
        guard let state = browser.view?.state else { return false }
        return !state.closed && !state.tabs.isEmpty
    }
    /// The page went somewhere, or its title changed.
    func deviceTabPage(_ id: String, url: String, title: String?) {
        var value: [String: Any] = ["kind": "page", "tabId": id, "url": url]
        if let title { value["title"] = title }
        deviceTabAction(value)
    }
    /// A load failed before the page changed; `url` is where it was going.
    func deviceTabFailed(_ id: String, url: String) {
        deviceTabAction(["kind": "failed", "tabId": id, "url": url])
    }
    private func deviceTabAction(_ value: [String: Any]) { action(["type": "device.tab", "action": value]) }
}
