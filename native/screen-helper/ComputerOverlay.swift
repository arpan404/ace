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
    private var shownAt: UInt64 = 0
    private let idleNs: UInt64
    private let now: () -> UInt64

    /// The pointer stays through the model's pause between batches, then goes away once the
    /// agent has stopped acting, so it never lingers over the person's window (or keeps polling).
    init(idleSeconds: Double = 30, now: @escaping () -> UInt64 = cuNow) {
        idleNs = UInt64(idleSeconds * 1_000_000_000)
        self.now = now
    }

    var isShowing: Bool { anchor != nil }

    /// Keep the last pointer visible between batches, without a per-click fade-out.
    func show(at point: CGPoint, window: CUWindow?) {
        guard let window, let number = window.number, !cuScreenLocked() else { hide(); return }
        shownAt = now()
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
        if anchor != nil, now() &- shownAt >= idleNs { hide(); return }
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
        let size = CUAceCursorView.size
        let origin = CGPoint(x: point.x - CUAceCursorView.hotSpot.x,
                             y: primary.frame.height - point.y - size.height + CUAceCursorView.hotSpot.y)
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
        panel.contentView = CUAceCursorView(frame: CGRect(origin: .zero, size: frame.size))
        return panel
    }
}

/// The same Pebble pointer as ace's computer-use icon and in-page agent cursor.
private final class CUAceCursorView: NSView {
    private static let scale: CGFloat = 1.25
    static let size = CGSize(width: CUAgentCursorGlyph.box * scale, height: CUAgentCursorGlyph.box * scale)
    static let hotSpot = CGPoint(x: CUAgentCursorGlyph.tip.x * scale, y: CUAgentCursorGlyph.tip.y * scale)
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let path = CUAgentCursorGlyph.path()
        let transform = AffineTransform(scale: Self.scale)
        path.transform(using: transform)
        NSColor.labelColor.setFill()
        path.fill()
        NSColor.textBackgroundColor.setStroke()
        path.lineWidth = CUAgentCursorGlyph.outline * Self.scale
        path.lineJoinStyle = .round
        path.stroke()
    }
}
