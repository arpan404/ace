import SwiftUI

/// What the split view lends the thread for its side panel (`InboxSplit`): the list's width, and
/// a way to have the list step aside while the panel needs its room.
struct PanelRoom {
    /// The list beside the thread, or the list stepped aside for the panel; 0 when the person
    /// hid it, or there is none.
    let list: CGFloat
    /// The list stepped aside for the panel: the thread's column includes its width now.
    let yielded: Bool
    /// Each time the person brought the list back over a panel that needed its room.
    let reclaimed: Int
    let yield: (Bool) -> Void
}

extension EnvironmentValues {
    @Entry var panelRoom: PanelRoom?
}

/// The thread beside its side panel (iPad, a wide window). The panel's tabs and width are the
/// thread's own (`ThreadPanels`); where it goes is the window's (`PanelPlace`). With no room the
/// thread shows alone and its tools open over it as on a phone. The panel arrives and leaves
/// with the system spring (a fade under Reduce Motion), and its edge drags to resize: while the
/// finger moves only the panel moves, over the thread, which takes its new width once let go.
struct ThreadWorkspace<Thread: View>: View {
    @Bindable var model: ClientModel
    @Bindable var thread: ThreadModel
    let title: String
    let subtitle: String
    let openThread: (String) -> Void
    let mention: ((String) -> Void)?
    /// Where the panel goes now, for the thread's ⋯ menu and keys.
    @Binding var place: PanelPlace
    @ViewBuilder let content: () -> Thread
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.panelRoom) private var room
    @State private var width: CGFloat = 0
    /// The width let go at, shown until the bridge sends it back, so the edge never snaps back.
    @State private var pending: Double?

    private var view: PanelView? { model.panels.views[thread.id] }
    private var motion: Animation { reduceMotion ? AceTheme.Motion.standardCurve : AceTheme.Motion.spring }
    /// The thread's column as it would be with the list showing.
    private var besideList: CGFloat { room?.yielded == true ? width - (room?.list ?? 0) : width }
    private var computedPlace: PanelPlace {
        guard let view, width > 0 else { return .none }
        return PanelPlace.of(regular: sizeClass == .regular, width: besideList, list: room?.list ?? 0, limits: view.limits)
    }
    private var showing: PanelView? {
        guard let view, view.open, view.shown != nil, place != .none else { return nil }
        return view
    }
    private func size(_ view: PanelView) -> Double { pending ?? view.size }
    private func resize(_ size: CGFloat) {
        pending = Double(size)
        model.panel(thread.id, ["op": "size", "size": Double(size)])
    }
    private func panelWidth(_ view: PanelView, size: Double) -> CGFloat {
        PanelPlace.width(size: size, column: width, limits: view.limits)
    }

    var body: some View {
        ZStack(alignment: .trailing) {
            content()
                .padding(.trailing, showing.map { panelWidth($0, size: size($0)) + AceTheme.Dimensions.border } ?? 0)
            if let shown = showing {
                let settled = panelWidth(shown, size: size(shown))
                PanelColumn(settled: settled, clamp: { panelWidth(shown, size: Double($0)) },
                            resize: { next in withAnimation(motion) { resize(next) } }) { panel(shown) }
                    .transition(reduceMotion ? .opacity : .move(edge: .trailing))
            }
        }
        .animation(motion, value: showing?.open)
        .onChange(of: view?.size) { _, now in if now == pending { pending = nil } }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .onChange(of: computedPlace, initial: true) { _, now in place = now }
        // The list steps aside while a panel that needs its room shows, and comes back after.
        .onChange(of: place == .yield && view?.open == true, initial: true) { _, wants in room?.yield(wants) }
        // The person brought the list back over it: the panel gives way.
        .onChange(of: room?.reclaimed ?? 0) { _, _ in
            if place == .yield, view?.open == true { model.panel(thread.id, ["op": "panel", "open": false]) }
        }
        .task(id: thread.id) { if sizeClass == .regular { model.panel(thread.id) } }
        .onChange(of: sizeClass) { _, now in if now == .regular { model.panel(thread.id) } }
    }

    private func panel(_ view: PanelView) -> some View {
        VStack(spacing: AceTheme.Spacing.none) {
            PanelTabStrip(view: view) { op in withAnimation(motion) { model.panel(thread.id, op) } }
            Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border)
            if let tab = view.shown, let tool = tab.tool {
                PanelContent(tool: tool, model: model, thread: thread, title: title, subtitle: subtitle, openThread: openThread, mention: mention)
                    .id(tab.key)
                    .environment(\.panelHost, PanelHost { withAnimation(motion) { model.panel(thread.id, ["op": "panel", "open": false]) } })
                    .transition(.opacity)
            }
            Spacer(minLength: 0)
        }
        .background(AceTheme.Colours.background)
        .animation(motion, value: view.tabs)
        .animation(motion, value: view.active)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Thread panel")
        .accessibilityIdentifier("panel")
    }
}

/// The panel with its leading edge: a hairline with a grabber, a 24-point target to drag. While
/// the edge is held only this column redraws: the panel widens over the thread or narrows away
/// from it, and the thread takes the new width once let go. VoiceOver and Full Keyboard Access
/// adjust it in steps.
private struct PanelColumn<Panel: View>: View {
    let settled: CGFloat
    /// The width a size would be, kept inside the panel's bounds.
    let clamp: (CGFloat) -> CGFloat
    let resize: (CGFloat) -> Void
    @ViewBuilder let panel: () -> Panel
    /// How far the edge has moved while held; the panel grows as it moves left.
    @GestureState private var pull: CGFloat = 0
    @GestureState private var held = false

    var body: some View {
        let live = clamp(settled + pull)
        HStack(spacing: AceTheme.Spacing.none) {
            edge(live)
            panel().frame(width: live)
        }
    }

    private func edge(_ live: CGFloat) -> some View {
        Rectangle().fill(AceTheme.Colours.separator)
            .frame(width: AceTheme.Dimensions.border)
            .overlay {
                Capsule().fill(held ? AceTheme.Colours.mutedForeground : AceTheme.Colours.decoration)
                    .frame(width: 4, height: 36)
            }
            .frame(maxHeight: .infinity)
            .overlay {
                Color.clear.frame(width: 24).contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 2, coordinateSpace: .global)
                            .updating($pull) { value, pull, _ in pull = -value.translation.width }
                            .updating($held) { _, held, _ in held = true }
                            .onEnded { value in resize(clamp(settled - value.translation.width)) }
                    )
                    .hoverEffect(.highlight)
            }
            .accessibilityElement()
            .accessibilityLabel("Panel width")
            .accessibilityValue("\(Int(live)) points")
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: resize(clamp(settled + 40))
                case .decrement: resize(clamp(settled - 40))
                @unknown default: break
                }
            }
            .accessibilityIdentifier("panel.edge")
    }
}
