import AppKit
import SwiftUI

private final class TrayPanel: NSPanel {
    override var canBecomeKey: Bool { true }

    override func cancelOperation(_ sender: Any?) { close() }
}

private final class TrayApplication: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let model = TrayModel()
    private var panel: TrayPanel?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let arguments = CommandLine.arguments
        guard arguments.count == 6,
              let x = Double(arguments[1]), x.isFinite,
              let y = Double(arguments[2]), y.isFinite,
              let width = Double(arguments[3]), (1...360).contains(width),
              let height = Double(arguments[4]), (1...510).contains(height),
              let origin = NSScreen.screens.first else {
            NSApp.terminate(nil)
            return
        }
        model.tab = Tab(rawValue: arguments[5]) ?? .agents
        let bounds = NSRect(x: x, y: origin.frame.maxY - y - height, width: width, height: height)
        let panel = TrayPanel(
            contentRect: bounds, styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false
        )
        panel.title = "ace menu bar"
        panel.level = .popUpMenu
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.delegate = self
        let material = NSVisualEffectView(frame: NSRect(origin: .zero, size: bounds.size))
        material.material = .popover
        material.blendingMode = .behindWindow
        material.state = .active
        material.wantsLayer = true
        material.layer?.cornerCurve = .continuous
        material.layer?.cornerRadius = 16
        material.layer?.masksToBounds = true
        let host = NSHostingView(rootView: TrayView(model: model))
        host.frame = material.bounds
        host.autoresizingMask = [.width, .height]
        material.addSubview(host)
        panel.contentView = material
        self.panel = panel
        DispatchQueue.global(qos: .utility).async { [weak self] in
            while let line = readLine() {
                guard line.utf8.count <= 2_097_152,
                      let snapshot = try? JSONDecoder().decode(Snapshot.self, from: Data(line.utf8))
                else { continue }
                DispatchQueue.main.async {
                    guard let self else { return }
                    if self.model.receive(snapshot) {
                        panel.appearance = snapshot.appearance.flatMap {
                            NSAppearance(named: $0.dark ? .darkAqua : .aqua)
                        }
                        material.layer?.cornerRadius = 16 * (snapshot.appearance?.radius ?? 1)
                        material.layer?.borderWidth = (snapshot.appearance?.border ?? 1) / panel.backingScaleFactor
                        material.layer?.borderColor = NSColor.labelColor.withAlphaComponent(0.14).cgColor
                    }
                }
            }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
        panel.makeKeyAndOrderFront(nil)
    }

    func windowDidResignKey(_ notification: Notification) { panel?.close() }
    func windowWillClose(_ notification: Notification) { NSApp.terminate(nil) }
}

let app = NSApplication.shared
private let delegate = TrayApplication()
app.setActivationPolicy(.accessory)
app.delegate = delegate
app.run()
