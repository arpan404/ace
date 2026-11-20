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
        if deviceTabs.shown == id { deviceTabs.shown = nil }
        deviceTabAction(["kind": "close", "tabId": id])
    }
    /// Shows a device tab in the browser; it takes the phone's loopback ports for this machine.
    func showDeviceTab(_ id: String) {
        deviceTabs.shown = id
        deviceTabAction(["kind": "front", "tabId": id])
    }
    /// The tab's page is on screen again (the browser came back to the front).
    func frontDeviceTab() {
        guard let id = deviceTabs.shown else { return }
        deviceTabAction(["kind": "front", "tabId": id])
    }
    /// Shows ace's Chrome again; the device tabs stay open.
    func showChrome() { deviceTabs.shown = nil }
    /// The page went somewhere, or its title changed.
    func deviceTabPage(_ id: String, url: String, title: String?) {
        var value: [String: Any] = ["kind": "page", "tabId": id, "url": url]
        if let title { value["title"] = title }
        deviceTabAction(value)
    }
    private func deviceTabAction(_ value: [String: Any]) { action(["type": "device.tab", "action": value]) }
}
