import SwiftUI

/// What the split view lends the open thread's side panel (`InboxSplit`): the window's width and
/// where it reads the panel's place.
struct PanelRoom {
    /// The window's width: the split view and the panel together.
    let window: CGFloat
    /// Where the panel goes, for the thread's ⋯ menu, panel button and keys.
    let place: Binding<PanelPlace>
}

extension EnvironmentValues {
    @Entry var panelRoom: PanelRoom?
    /// Where the open thread's side panel goes; `.none` keeps its tools over the thread.
    @Entry var panelPlace = PanelPlace.none
}

/// Which part of the panel a view is: the decisions, always there behind the split view, or
/// the column itself.
enum PanelPart { case state, column }

/// The open thread's side panel (iPad, a wide window): a trailing column of the window beside
/// the split view, with its own bar and stack, so what a tab's screen shows and pushes stays in
/// it. Its tabs and width are the thread's (`ThreadPanels`); where it goes is the window's
/// (`PanelPlace`). With no room it doesn't show and the thread's tools open over it as on a
/// phone. The split view takes the rest, and puts its list away when the two don't fit beside
/// the thread. The panel arrives and leaves with the system spring (a fade under Reduce Motion);
/// its edge drags to resize, the panel overhanging the thread until let go.
struct ThreadSidePanel: View {
    @Bindable var model: ClientModel
    let threadId: String
    let part: PanelPart
    let openThread: (String) -> Void

    var body: some View {
        switch part {
        case .state: PanelState(model: model, threadId: threadId)
        case .column: PanelSide(model: model, threadId: threadId, openThread: openThread)
        }
    }
}

/// Decides where the panel goes, without drawing anything.
private struct PanelState: View {
    @Bindable var model: ClientModel
    let threadId: String
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.panelRoom) private var room

    private var place: PanelPlace {
        guard let view = model.panels.views[threadId], let room, room.window > 0 else { return .none }
        return PanelPlace.of(regular: sizeClass == .regular, width: room.window, limits: view.limits)
    }

    var body: some View {
        Color.clear.frame(width: 0, height: 0).accessibilityHidden(true)
            .onChange(of: place, initial: true) { _, now in room?.place.wrappedValue = now }
            .task(id: threadId) { if sizeClass == .regular { model.panel(threadId) } }
            .onChange(of: sizeClass) { _, now in if now == .regular { model.panel(threadId) } }
    }
}

/// The column, when the thread's panel is open and has room.
private struct PanelSide: View {
    @Bindable var model: ClientModel
    let threadId: String
    let openThread: (String) -> Void
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.panelRoom) private var room
    /// The width let go at, shown until the bridge sends it back, so the edge never snaps back.
    @State private var pending: Double?

    private var view: PanelView? { model.panels.views[threadId] }
    /// The thread the panel's screens read: the one the client shows, once it is this one.
    private var thread: ThreadModel? { model.thread.flatMap { $0.id == threadId ? $0 : nil } }
    private var motion: Animation { reduceMotion ? AceTheme.Motion.standardCurve : AceTheme.Motion.spring }
    private var showing: PanelView? {
        guard let view, view.open, view.shown != nil, let room, thread != nil,
              PanelPlace.of(regular: sizeClass == .regular, width: room.window, limits: view.limits) == .beside else { return nil }
        return view
    }
    private func width(_ view: PanelView, size: Double) -> CGFloat {
        PanelPlace.width(size: size, column: room?.window ?? 0, limits: view.limits)
    }

    var body: some View {
        Group {
            if let shown = showing, let thread {
                let settled = width(shown, size: pending ?? shown.size)
                PanelColumn(settled: settled, clamp: { width(shown, size: Double($0)) }, resize: { next in
                    withAnimation(motion) {
                        pending = Double(next)
                        model.panel(threadId, ["op": "size", "size": Double(next)])
                    }
                }) { panel(shown, thread: thread) }
                .transition(reduceMotion ? .opacity : .move(edge: .trailing))
            }
        }
        .animation(motion, value: showing != nil)
        .onChange(of: view?.size) { _, now in if now == pending { pending = nil } }
    }

    private func panel(_ view: PanelView, thread: ThreadModel) -> some View {
        let row = model.inbox[threadId]
        let subtitle = [row?.project ?? "", row?.branch.isEmpty == false ? row?.branch ?? "" : row?.machine ?? ""]
            .filter { !$0.isEmpty }.joined(separator: " · ")
        return VStack(spacing: AceTheme.Spacing.none) {
            PanelTabStrip(view: view) { op in withAnimation(motion) { model.panel(threadId, op) } }
            Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border)
            if let tab = view.shown, let tool = tab.tool {
                PanelContent(tool: tool, model: model, thread: thread, title: row?.title ?? "", subtitle: subtitle, openThread: openThread,
                             mention: model.canOperate ? { model.panels.mention(threadId, $0) } : nil)
                    .environment(\.panelHost, PanelHost { withAnimation(motion) { model.panel(threadId, ["op": "panel", "open": false]) } })
                    .id(tab.key)
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
/// the edge is held only this column redraws: its frame keeps the settled width, so the thread
/// beside it is not laid out again each frame, and the panel overhangs the thread or narrows
/// away from it. The thread takes the new width once let go. VoiceOver and Full Keyboard Access
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
        .background(AceTheme.Colours.background)
        .frame(width: settled + AceTheme.Dimensions.border, alignment: .trailing)
        .zIndex(1)
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
