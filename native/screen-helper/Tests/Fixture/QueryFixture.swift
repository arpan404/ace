import AppKit

/// Disposable, static controls for the native search benchmark. Never activates the app.
@main struct QueryFixture {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        app.finishLaunching()
        let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 1000, height: 760),
            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "ace owned search fixture"
        for index in 0..<400 {
            let value = index == 210 ? "target invoice record" : "row \(index) " + String(repeating: "sample text ", count: 130)
            let field = NSTextField(string: value)
            field.frame = NSRect(x: 20 + (index % 10) * 95, y: 40 + (index / 10) * 17, width: 88, height: 16)
            window.contentView?.addSubview(field)
        }
        window.orderFrontRegardless()
        if window.canBecomeMain { window.makeMain() }
        print("ready"); fflush(stdout)
        withExtendedLifetime(window) { app.run() }
    }
}
