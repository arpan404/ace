import AppKit
import SwiftUI

/// The tray's resolved inks and font, from the person's theme or Suit.
struct TrayInk {
    let foreground: Color
    let muted: Color
    let font: String?

    func ui(_ size: CGFloat) -> Font {
        if let font, NSFont(name: font, size: size) != nil { return .custom(font, size: size) }
        return .system(size: size)
    }
}

/// A full-width row: a wash under the pointer, a stronger one while pressed.
/// 8pt corners sit concentric inside the panel's 16pt corners and 8pt inset.
struct TrayRowStyle: ButtonStyle {
    let ink: Color

    func makeBody(configuration: Configuration) -> some View {
        Row(configuration: configuration, ink: ink)
    }

    private struct Row: View {
        let configuration: ButtonStyle.Configuration
        let ink: Color
        @Environment(\.isEnabled) private var enabled
        @State private var hovered = false

        var body: some View {
            configuration.label
                .opacity(enabled ? 1 : 0.45)
                .background(
                    ink.opacity(configuration.isPressed ? 0.1 : hovered && enabled ? 0.06 : 0),
                    in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                )
                .animation(.easeOut(duration: 0.12), value: hovered)
                .onHover { hovered = $0 }
        }
    }
}

/// A small flat word button inside a row (Take over, Stop, banked resets).
struct TrayPillStyle: ButtonStyle {
    let ink: Color
    let tone: Color

    func makeBody(configuration: Configuration) -> some View {
        Pill(configuration: configuration, ink: ink, tone: tone)
    }

    private struct Pill: View {
        let configuration: ButtonStyle.Configuration
        let ink: Color
        let tone: Color
        @Environment(\.isEnabled) private var enabled
        @State private var hovered = false

        var body: some View {
            configuration.label
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(tone)
                .lineLimit(1)
                .padding(.horizontal, 9)
                .frame(height: 22)
                .background(
                    ink.opacity(configuration.isPressed ? 0.16 : hovered ? 0.11 : 0.07),
                    in: Capsule()
                )
                .opacity(enabled ? 1 : 0.45)
                .contentShape(Capsule())
                .onHover { hovered = $0 }
        }
    }
}

/// A thin remaining-quota bar; an empty track when the window has no reading.
struct TrayMeter: View {
    let fraction: Double?
    let fill: Color
    let track: Color

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(track)
                if let fraction, fraction > 0 {
                    Capsule().fill(fill)
                        .frame(width: max(4, proxy.size.width * fraction))
                }
            }
        }
        .frame(height: 4)
        .accessibilityHidden(true)
    }
}

extension String {
    var trayColor: Color {
        let value = UInt32(dropFirst(), radix: 16) ?? 0
        return Color(
            red: Double(value >> 16) / 255,
            green: Double((value >> 8) & 255) / 255,
            blue: Double(value & 255) / 255
        )
    }
}

/// Keeps the list's scroller an overlay, so a "show scroll bars: always" Mac
/// doesn't carve an empty gutter out of every row. The indicator still shows
/// while scrolling.
struct TrayOverlayScroller: NSViewRepresentable {
    func makeNSView(context: Context) -> Probe { Probe() }
    func updateNSView(_ view: Probe, context: Context) { view.apply() }

    final class Probe: NSView {
        private var observer: NSObjectProtocol?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            apply()
            guard observer == nil else { return }
            observer = NotificationCenter.default.addObserver(
                forName: NSScroller.preferredScrollerStyleDidChangeNotification,
                object: nil, queue: .main
            ) { [weak self] _ in DispatchQueue.main.async { self?.apply() } }
        }

        func apply() {
            guard let scroll = enclosingScrollView, scroll.scrollerStyle != .overlay else { return }
            scroll.scrollerStyle = .overlay
        }

        deinit { observer.map(NotificationCenter.default.removeObserver) }
    }
}
