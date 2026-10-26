import SwiftUI
import UIKit

/// The open page's leading button in a compact window, where the back chevron was: it brings
/// the list out over the page (`ThreadDrawer`).
struct DrawerButton: View {
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            AceIcon(.sidebarSimple, size: 20)
                .foregroundStyle(AceTheme.Colours.foreground)
                .frame(width: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm, height: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Open sidebar")
        .accessibilityIdentifier("thread.sidebar")
        .keyboardShortcut("s", modifiers: [.command, .control])
    }
}

/// The dimmed page beside the open list: a tap closes the list, a drag towards the list follows
/// the finger and settles open or closed. VoiceOver reads it as one Close sidebar button.
struct DrawerCloser: View {
    let close: () -> Void
    /// The drag's horizontal translation so far.
    let moved: (CGFloat) -> Void
    /// The drag's translation and velocity where it was let go.
    let ended: (CGFloat, CGFloat) -> Void

    var body: some View {
        Color.clear
            .contentShape(Rectangle())
            .onTapGesture(perform: close)
            .gesture(
                // Measured in the window: the page under the finger moves with it.
                DragGesture(minimumDistance: AceTheme.Spacing.sm, coordinateSpace: .global)
                    .onChanged { moved($0.translation.width) }
                    .onEnded { ended($0.translation.width, $0.velocity.width) })
            .accessibilityElement()
            .accessibilityLabel("Close sidebar")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { close() }
            .accessibilityIdentifier("drawer.close")
    }
}

/// The swipe in from the window's leading edge that brings the list out over the open page. A
/// screen-edge recogniser takes only touches that start at the edge, so it never claims the
/// transcript's sideways scrolling (code blocks, tables) or the composer's own touches, and taps
/// at the edge still land where they fall.
struct DrawerEdgePan: UIGestureRecognizerRepresentable {
    let enabled: Bool
    /// Whether the list follows the finger; Reduce Motion opens it as the swipe begins.
    let follows: Bool
    let began: () -> Void
    let moved: (CGFloat) -> Void
    let ended: (CGFloat, CGFloat) -> Void

    func makeUIGestureRecognizer(context: Context) -> UIScreenEdgePanGestureRecognizer {
        let pan = UIScreenEdgePanGestureRecognizer()
        pan.edges = .left
        return pan
    }
    func updateUIGestureRecognizer(_ pan: UIScreenEdgePanGestureRecognizer, context: Context) {
        if pan.isEnabled != enabled { pan.isEnabled = enabled }
    }
    func handleUIGestureRecognizerAction(_ pan: UIScreenEdgePanGestureRecognizer, context: Context) {
        let translation = pan.translation(in: pan.view).x
        switch pan.state {
        case .began: began()
        case .changed: if follows { moved(translation) }
        case .ended: ended(translation, pan.velocity(in: pan.view).x)
        case .cancelled, .failed: ended(0, 0)
        default: break
        }
    }
}

extension View {
    /// The page's clip while it is out of place: the display's own rounded corners.
    func displayCorners(_ rounded: Bool) -> some View {
        clipShape(Self.cornerShape(rounded))
    }
    private static func cornerShape(_ rounded: Bool) -> AnyShape {
        guard rounded else { return AnyShape(Rectangle()) }
        if #available(iOS 26, *) { return AnyShape(ConcentricRectangle()) }
        return AnyShape(RoundedRectangle(cornerRadius: AceTheme.Spacing.xxl * 1.5, style: .continuous))
    }
}
