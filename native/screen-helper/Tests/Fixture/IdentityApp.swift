import AppKit

final class FixtureWindow: NSWindow {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}
final class FixtureText: NSTextView {
    override func isAccessibilityFocused() -> Bool { window?.firstResponder === self }
}
@MainActor final class IdentityDelegate: NSObject, NSApplicationDelegate {
    var windows: [NSWindow] = []
    func emit(_ value: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) { print(line); fflush(stdout) }
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let applicationItem = NSMenuItem(title: "IdentityFixture", action: nil, keyEquivalent: "")
        applicationItem.submenu = NSMenu(title: "IdentityFixture"); menu.addItem(applicationItem)
        let file = NSMenuItem(title: "Fixture", action: nil, keyEquivalent: "")
        let submenu = NSMenu(title: "Fixture")
        submenu.addItem(withTitle: "Signal", action: #selector(signal), keyEquivalent: "l").target = self
        file.submenu = submenu; menu.addItem(file); NSApp.mainMenu = menu
        let originX: CGFloat = CommandLine.arguments.contains("--onscreen") ? 100 : 100000
        for index in 0..<2 {
            let window = FixtureWindow(contentRect: NSRect(x: originX, y: 200, width: 360, height: 200), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "Identity \(index)"
            let text = FixtureText(frame: NSRect(x: 10, y: 10, width: 320, height: 150))
            text.setAccessibilityLabel("Destination \(index)")
            window.contentView?.addSubview(text)
            window.makeFirstResponder(text)
            window.setFrameOrigin(NSPoint(x: originX, y: 200))
            window.orderFront(nil)
            windows.append(window)
        }
        emit(["ready": windows.map { $0.windowNumber }])
        DispatchQueue.global().async { [weak self] in
            while let line = readLine() {
                DispatchQueue.main.async {
                    guard let self else { return }
                    if line == "snapshot" { self.emit(["values": self.windows.map { ($0.contentView?.subviews.first as? NSTextView)?.string ?? "" }, "active": NSApp.isActive]) }
                    if line == "offdisplay" { self.windows[1].setFrameOrigin(NSPoint(x: 110000, y: 200)); self.emit(["moved": true]) }
                    if line == "quit" { NSApp.terminate(nil) }
                }
            }
        }
    }
    @objc func signal() { emit(["menu": "signal"]) }
    func application(_ application: NSApplication, open urls: [URL]) { emit(["urls": urls.map(\.absoluteString)]) }
}
@objc(IdentityApplication) final class IdentityApplication: NSApplication {
    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown || event.type == .keyUp {
            (delegate as? IdentityDelegate)?.emit(["eventWindow": event.windowNumber, "keyCode": event.keyCode, "down": event.type == .keyDown])
        }
        super.sendEvent(event)
    }
}
@main struct IdentityApp {
    @MainActor static func main() {
        let app = IdentityApplication.shared
        let delegate = IdentityDelegate(); app.delegate = delegate
        app.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { app.finishLaunching(); app.run() }
    }
}
