import AppKit
import QuartzCore

/// The agent's pointer follows the target window, independently of the person's cursor.
struct CUCursorAnchor {
    let window: CGWindowID
    let localPoint: CGPoint

    func screenPoint(in frame: CGRect) -> CGPoint {
        CGPoint(x: frame.minX + localPoint.x, y: frame.minY + localPoint.y)
    }
}

@MainActor final class CUOverlay {
    private var panel: NSPanel?
    private var anchor: CUCursorAnchor?
    private var tracking: Timer?
    private let cursor = NSCursor.arrow

    /// Keep the last pointer visible between batches, without a per-click fade-out.
    func show(at point: CGPoint, window: CUWindow?) {
        guard let window, let number = window.number, !cuScreenLocked() else { hide(); return }
        anchor = CUCursorAnchor(window: number, localPoint: CGPoint(x: point.x - window.frame.minX, y: point.y - window.frame.minY))
        update()
        if tracking == nil {
            tracking = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.update() }
            }
        }
    }

    func hide() {
        tracking?.invalidate()
        tracking = nil
        anchor = nil
        panel?.orderOut(nil)
    }

    private func update() {
        guard let anchor, !cuScreenLocked(),
              let window = cuServerWindowInfo([anchor.window])[anchor.window], window.onScreen, let frame = window.frame else {
            panel?.orderOut(nil)
            return
        }
        let point = anchor.screenPoint(in: frame)
        guard frame.contains(point), visible(window: anchor.window, at: point), let primary = NSScreen.screens.first else {
            panel?.orderOut(nil)
            return
        }
        // Cursor hotspots are top-left based; panel origins are bottom-left based.
        let size = CGSize(width: 56, height: max(38, cursor.image.size.height + 8))
        let origin = CGPoint(x: point.x - cursor.hotSpot.x,
                             y: primary.frame.height - point.y - size.height + cursor.hotSpot.y)
        let destination = CGRect(origin: origin, size: size)
        let panel = self.panel ?? makePanel(destination)
        self.panel = panel
        guard panel.frame != destination || !panel.isVisible else { return }
        if panel.isVisible, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.16
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                panel.animator().setFrame(destination, display: true)
            }
        } else {
            panel.setFrame(destination, display: true)
            panel.orderFrontRegardless()
        }
    }

    /// Hide over a covered window instead of pointing at the person's unrelated app.
    private func visible(window: CGWindowID, at point: CGPoint) -> Bool {
        let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        for row in rows {
            guard (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  ((row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0,
                  let bounds = row[kCGWindowBounds as String] as? NSDictionary,
                  let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary), frame.contains(point) else { continue }
            return (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value == window
        }
        return false
    }

    private func makePanel(_ frame: CGRect) -> NSPanel {
        let panel = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .statusBar
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        let content = NSView(frame: CGRect(origin: .zero, size: frame.size))
        let image = NSImageView(frame: CGRect(x: 0, y: frame.height - cursor.image.size.height, width: cursor.image.size.width, height: cursor.image.size.height))
        image.image = cursor.image
        image.imageScaling = .scaleNone
        content.addSubview(image)
        let label = NSTextField(labelWithString: "ace")
        label.font = .systemFont(ofSize: 10, weight: .semibold)
        label.textColor = .white
        label.backgroundColor = .controlAccentColor
        label.drawsBackground = true
        label.alignment = .center
        label.wantsLayer = true
        label.layer?.cornerRadius = 3
        label.layer?.masksToBounds = true
        label.frame = CGRect(x: 17, y: 2, width: 26, height: 15)
        content.addSubview(label)
        panel.contentView = content
        return panel
    }
}
