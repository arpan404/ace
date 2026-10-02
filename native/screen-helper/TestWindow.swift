import AppKit
@objc(ScreenTestApplication) final class TestApplication: NSApplication {}
final class TestButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class TestPattern: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor(deviceRed: 1, green: 0, blue: 0, alpha: 1).setFill(); NSRect(x: 20, y: 220, width: 160, height: 60).fill()
        NSColor(deviceRed: 0, green: 0, blue: 1, alpha: 1).setFill(); NSRect(x: 220, y: 220, width: 160, height: 60).fill()
    }
}
final class TestDocument: NSView { override var isFlipped: Bool { true } }
final class TestScroll: NSScrollView {}
@MainActor final class TestDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    private var window: NSWindow?
    private var scrollObserver: NSObjectProtocol?
    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 400, height: 300), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        self.window = window
        window.title = String((CommandLine.arguments.dropFirst().first ?? "ace screen integration").prefix(64))
        window.contentView = TestPattern(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
        let view = NSTextField(string: "")
        view.delegate = self
        view.frame = NSRect(x: 40, y: 100, width: 300, height: 50)
        window.contentView?.addSubview(view)
        let button = TestButton(title: "Click test", target: self, action: #selector(clicked(_:)))
        button.frame = NSRect(x: 40, y: 30, width: 160, height: 32)
        button.keyEquivalent = "\r"
        window.contentView?.addSubview(button)
        let scroll = TestScroll(frame: NSRect(x: 220, y: 30, width: 140, height: 80))
        scroll.hasVerticalScroller = true
        scroll.documentView = TestDocument(frame: NSRect(x: 0, y: 0, width: 120, height: 1200))
        window.contentView?.addSubview(scroll)
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        window.makeFirstResponder(view)
        DispatchQueue.main.async { [self] in
            window.displayIfNeeded()
            let clip = scroll.contentView
            clip.postsBoundsChangedNotifications = true
            var last = clip.bounds.origin
            scrollObserver = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: clip, queue: .main) { _ in
                if clip.bounds.origin != last { last = clip.bounds.origin; print("scrolled"); fflush(stdout) }
            }
            print("ready"); fflush(stdout)
        }
    }
    @objc func clicked(_ sender: NSButton) { print("clicked"); fflush(stdout) }
    func controlTextDidChange(_ notification: Notification) {
        guard let field = notification.object as? NSTextField else { return }
        print("typed:" + field.stringValue); fflush(stdout)
    }
}
@main struct TestWindow {
    @MainActor static func main() {
        let app = TestApplication.shared
        let delegate = TestDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.finishLaunching(); app.run() }
    }
}
