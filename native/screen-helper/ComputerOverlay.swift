import AppKit

/// A small marker that glides to where the agent acts on a visible window, so the person can
/// follow along. It never takes clicks or focus, and the real cursor never moves.
/// (Esc to stop is `CUEscapeWatcher`.)
@MainActor final class CUOverlay {
    private var panel: NSPanel?
    private var hide: DispatchWorkItem?

    /// `point` is a global top-left screen point inside an on-screen window. AppKit's global
    /// coordinates are anchored to the primary display, whichever display the window is on.
    func show(at point: CGPoint) {
        guard let primary = NSScreen.screens.first else { return }
        let size: CGFloat = 26
        let origin = CGPoint(x: point.x - size / 2, y: primary.frame.height - point.y - size / 2)
        let frame = CGRect(origin: origin, size: CGSize(width: size, height: size))
        let panel = self.panel ?? makePanel(frame)
        self.panel = panel
        if panel.isVisible && panel.alphaValue > 0.1 {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.18
                panel.animator().setFrame(frame, display: true)
            }
        } else {
            panel.setFrame(frame, display: true)
            panel.alphaValue = 1
            panel.orderFrontRegardless()
        }
        hide?.cancel()
        let work = DispatchWorkItem { [weak panel] in
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.4
                panel?.animator().alphaValue = 0
            }
        }
        hide = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6, execute: work)
    }

    private func makePanel(_ frame: CGRect) -> NSPanel {
        let panel = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .statusBar
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        panel.contentView = CUMarkerView(frame: CGRect(origin: .zero, size: frame.size))
        return panel
    }
}

private final class CUMarkerView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        let ring = NSBezierPath(ovalIn: bounds.insetBy(dx: 3, dy: 3))
        NSColor(calibratedRed: 1.0, green: 0.22, blue: 0.55, alpha: 0.28).setFill()
        ring.fill()
        NSColor.white.setStroke()
        ring.lineWidth = 2
        ring.stroke()
        let dot = NSBezierPath(ovalIn: bounds.insetBy(dx: 9, dy: 9))
        NSColor(calibratedRed: 1.0, green: 0.22, blue: 0.55, alpha: 1).setFill()
        dot.fill()
    }
}
