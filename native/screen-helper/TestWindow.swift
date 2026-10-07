import AppKit
import CoreVideo
import QuartzCore
@objc(ScreenTestApplication) final class TestApplication: NSApplication {}
class TestButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class MeasurementButton: TestButton {
    override func accessibilityPerformPress() -> Bool { sendAction(action, to: target) }
}

final class TestPattern: NSView {
    var tick = 0
    private let measuring = CommandLine.arguments.contains(where: { $0.hasPrefix("--smoothness-") })
    var onDisplayed: (() -> Void)?
    override func draw(_ dirtyRect: NSRect) {
        let green = measuring ? Double(tick % 2) : Double(tick % 10) / 20
        NSColor(deviceRed: 1, green: green, blue: 0, alpha: 1).setFill(); NSRect(x: 20, y: 220, width: 160, height: 60).fill()
        NSColor(deviceRed: 0, green: 0, blue: 1, alpha: 1).setFill(); NSRect(x: 220, y: 220, width: 160, height: 60).fill()
        if measuring {
            for bit in 0..<8 {
                (tick & (1 << bit) == 0 ? NSColor.black : NSColor.white).setFill()
                NSRect(x: 20 + bit * 20, y: 220, width: 20, height: 20).fill()
            }
            NSColor.white.setFill(); NSRect(x: 20 + (tick % 32) * 4, y: 244, width: 12, height: 32).fill()
        }
        if let onDisplayed { self.onDisplayed = nil; DispatchQueue.main.async(execute: onDisplayed) }
    }
}
final class TestDocument: NSView { override var isFlipped: Bool { true } }
final class TestScroll: NSScrollView {}
@MainActor final class TestDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    private var window: NSWindow?
    private var animation: Timer?
    private var measurementStart: Double?
    private var stopMeasurementAnimation: (() -> Void)?
    private var injectedStall = false
    private var scrollObserver: NSObjectProtocol?
    private var readyObservers: [NSObjectProtocol] = []
    private weak var initialField: NSTextField?
    private var firstFrameDisplayed = false
    private var readyEmitted = false
    private let measuring = CommandLine.arguments.contains(where: { $0.hasPrefix("--smoothness-") })
    private func emitReady() {
        guard !readyEmitted, firstFrameDisplayed, let window, window.isVisible else { return }
        if !measuring {
            guard NSApplication.shared.isActive, window.isKeyWindow,
                  NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier,
                  let initialField, let responder = window.firstResponder, responder === initialField || responder === initialField.currentEditor() else { return }
        }
        readyEmitted = true
        for observer in readyObservers { NotificationCenter.default.removeObserver(observer) }
        readyObservers.removeAll()
        print("ready"); fflush(stdout)
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 400, height: 300), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        self.window = window
        window.title = String((CommandLine.arguments.dropFirst().first ?? "ace screen integration").prefix(64))
        window.contentView = TestPattern(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
        if CommandLine.arguments.contains("--animate"), let pattern = window.contentView as? TestPattern {
            animation = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in pattern.tick += 1; pattern.needsDisplay = true }
        }
        if !measuring {
            let view = NSTextField(string: "")
            initialField = view
            view.delegate = self
            view.frame = NSRect(x: 40, y: 100, width: 300, height: 50)
            window.contentView?.addSubview(view)
            let secure = NSSecureTextField(string: "fixture secret")
            secure.setAccessibilityLabel("Secret test")
            secure.frame = NSRect(x: 40, y: 165, width: 200, height: 32)
            window.contentView?.addSubview(secure)
            if CommandLine.arguments.contains("--large-text") {
                let document = NSTextView(frame: NSRect(x: 40, y: 205, width: 160, height: 12))
                document.string = String(repeating: "Q", count: 1024 * 1024)
                document.setAccessibilityLabel("Large text test")
                window.contentView?.addSubview(document)
            }
        }
        let button: TestButton
        if measuring {
            button = MeasurementButton(title: "Click test", target: self, action: #selector(clicked(_:)))
        } else { button = TestButton(title: "Click test", target: self, action: #selector(clicked(_:))) }
        button.frame = NSRect(x: 40, y: 30, width: 160, height: 32)
        if !measuring {
            let resize = TestButton(title: "Resize test", target: self, action: #selector(resized(_:)))
            resize.frame = NSRect(x: 220, y: 165, width: 160, height: 32)
            window.contentView?.addSubview(resize)
        }
        button.keyEquivalent = "\r"
        window.contentView?.addSubview(button)
        if !measuring {
            let scroll = TestScroll(frame: NSRect(x: 220, y: 30, width: 140, height: 80))
            scroll.hasVerticalScroller = true
            scroll.documentView = TestDocument(frame: NSRect(x: 0, y: 0, width: 120, height: 1200))
            window.contentView?.addSubview(scroll)
            DispatchQueue.main.async { [self] in
                let clip = scroll.contentView
                clip.postsBoundsChangedNotifications = true
                var last = clip.bounds.origin
                scrollObserver = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: clip, queue: .main) { _ in
                    if clip.bounds.origin != last { last = clip.bounds.origin; print("scrolled"); fflush(stdout) }
                }
            }
        }
        if let pattern = window.contentView as? TestPattern {
            pattern.onDisplayed = { [weak self] in self?.firstFrameDisplayed = true; self?.emitReady() }
        }
        for name in [NSApplication.didBecomeActiveNotification, NSWindow.didBecomeKeyNotification, NSApplication.didUpdateNotification] {
            readyObservers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.emitReady() }
            })
        }
        if measuring { window.orderFront(nil) }
        else {
            window.makeKeyAndOrderFront(nil)
            NSApplication.shared.activate(ignoringOtherApps: true)
            if let initialField { window.makeFirstResponder(initialField) }
        }
        DispatchQueue.main.async { [self] in window.displayIfNeeded(); emitReady() }
    }
    @objc func resized(_ sender: NSButton) { window?.setContentSize(NSSize(width: 800, height: 600)); print("resized"); fflush(stdout) }
    @objc func clicked(_ sender: NSButton) {
        print("clicked"); fflush(stdout)
        guard let pattern = window?.contentView as? TestPattern else { return }
        if CommandLine.arguments.contains("--smoothness-latency") {
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(180)) {
                pattern.tick += 1; pattern.needsDisplay = true
                print("response"); fflush(stdout)
            }
        } else if CommandLine.arguments.contains("--smoothness-smooth") || CommandLine.arguments.contains("--smoothness-stall") {
            animation?.invalidate(); injectedStall = false
            measurementStart = ProcessInfo.processInfo.systemUptime
            stopMeasurementAnimation?()
            if #available(macOS 14.0, *), let window {
                let link = window.displayLink(target: self, selector: #selector(animationFrame))
                let hz = Float(window.screen?.maximumFramesPerSecond ?? 60)
                link.preferredFrameRateRange = CAFrameRateRange(minimum: hz, maximum: hz, preferred: hz)
                link.add(to: .main, forMode: .common)
                stopMeasurementAnimation = { link.invalidate() }
            } else {
                var link: CVDisplayLink?
                let display = (window?.screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? CGMainDisplayID()
                guard CVDisplayLinkCreateWithCGDisplay(display, &link) == kCVReturnSuccess, let link else { return }
                CVDisplayLinkSetOutputHandler(link) { [weak self] _, _, _, _, _ in
                    DispatchQueue.main.async { self?.animationFrame() }
                    return kCVReturnSuccess
                }
                stopMeasurementAnimation = { CVDisplayLinkStop(link) }
                CVDisplayLinkStart(link)
            }
        }
    }
    @objc private func animationFrame() {
        guard let started = measurementStart, let pattern = window?.contentView as? TestPattern else { return }
        let elapsed = ProcessInfo.processInfo.systemUptime - started
        if elapsed >= 1.1 {
            stopMeasurementAnimation?(); stopMeasurementAnimation = nil
            print("settled"); fflush(stdout); return
        }
        if elapsed >= 0.4, !injectedStall, CommandLine.arguments.contains("--smoothness-stall") {
            injectedStall = true
            // This dedicated fixture deliberately blocks drawing for one known hitch.
            Thread.sleep(forTimeInterval: 0.12)
            print("stall"); fflush(stdout)
        }
        pattern.tick += 1; pattern.needsDisplay = true
        pattern.displayIfNeeded()
    }
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
        app.setActivationPolicy(CommandLine.arguments.contains(where: { $0.hasPrefix("--smoothness-") }) ? .accessory : .regular)
        withExtendedLifetime(delegate) { app.finishLaunching(); app.run() }
    }
}
