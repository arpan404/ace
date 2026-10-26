import SwiftUI
import UIKit

/// The open page's leading button in a compact window, where the back chevron was: it brings
/// the list out over the page (`ThreadDrawer`); its shortcut, ⌃⌘S, takes it in again too.
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

/// Places the page or the list for the drawer: offset, width, fade, dimming and corners. It is
/// the only reader of the finger's hold (`DrawerHold`), so each frame of a drag redraws these
/// modifiers over content built once outside them, never the thread's or the list's own body.
struct DrawerPlace: ViewModifier {
    enum Part { case page, list }
    let part: Part
    let hold: DrawerHold
    let open: Bool
    let window: CGFloat
    let reduceMotion: Bool
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        let layout = hold.layout
        let place = ThreadDrawer.placement(layout, progress: hold.progress ?? (open ? 1 : 0), window: window, reduceMotion: reduceMotion)
        switch part {
        case .page:
            content
                .overlay { AceTheme.Colours.scrim.opacity(AceTheme.Opacity.scrim(scheme) * 2 * place.dim).allowsHitTesting(false) }
                .displayCorners(place.rounded)
                .offset(x: place.pageOffset)
        case .list:
            content
                .frame(width: max(place.listWidth, 0))
                .offset(x: place.listOffset)
                .opacity(place.listOpacity)
                .allowsHitTesting(layout == .list || (open && hold.progress == nil))
                .accessibilityHidden(layout == .page && !open)
        }
    }
}

/// The dimmed page beside the open list: a tap closes the list, a drag towards the list follows
/// the finger and settles open or closed. It stays while a finger holds the drawer, even with
/// the list all the way in, so the drag always ends here. VoiceOver reads it as one Close
/// sidebar button.
struct DrawerCloser: View {
    let hold: DrawerHold
    let layout: ThreadDrawer.Layout
    let open: Bool
    let window: CGFloat
    let listWidth: CGFloat
    let reduceMotion: Bool
    let close: () -> Void
    /// The drag's velocity where it was let go, or zero when the system cancelled it.
    let ended: (CGFloat) -> Void
    @GestureState private var dragging = false

    var body: some View {
        if ThreadDrawer.closerShown(layout, open: open, held: hold.progress) {
            // Over the part of the page still in sight, beside the list.
            let shown = hold.progress ?? (open ? 1 : 0)
            let leading = reduceMotion ? listWidth : shown * listWidth
            Color.clear
                .contentShape(Rectangle())
                .onTapGesture(perform: close)
                .gesture(
                    // Measured in the window: the page under the finger moves with it.
                    DragGesture(minimumDistance: AceTheme.Spacing.sm, coordinateSpace: .global)
                        .updating($dragging) { _, state, _ in state = true }
                        .onChanged { value in
                            if hold.progress == nil { hold.begin(from: true) }
                            hold.move(value.translation.width, width: listWidth)
                        }
                        .onEnded { ended($0.velocity.width) })
                // A drag the system cancels never ends: it settles where the finger left it.
                .onChange(of: dragging) { _, now in if !now { ended(0) } }
                .frame(width: max(window - leading, 0))
                .frame(maxHeight: .infinity)
                .offset(x: leading)
                .accessibilityElement()
                .accessibilityLabel("Close sidebar")
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { close() }
                .accessibilityIdentifier("drawer.close")
        }
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
