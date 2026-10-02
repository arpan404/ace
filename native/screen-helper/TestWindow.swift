import AppKit
final class TextObserver: NSObject, NSTextFieldDelegate {
    func controlTextDidChange(_ notification: Notification) {
        guard let field = notification.object as? NSTextField else { return }
        print("typed:" + field.stringValue); fflush(stdout)
    }
}
@main struct TestWindow {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 400, height: 300), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "ace screen integration"
        let observer = TextObserver()
        let view = NSTextField(string: "")
        view.delegate = observer
        view.frame = NSRect(x: 40, y: 100, width: 300, height: 50)
        window.contentView?.addSubview(view)
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        window.makeFirstResponder(view)
        DispatchQueue.main.async { print("ready"); fflush(stdout) }
        withExtendedLifetime(observer) { app.run() }
    }
}
