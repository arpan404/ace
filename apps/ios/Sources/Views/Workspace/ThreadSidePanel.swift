import SwiftUI

/// What the split view lends the open thread's side panel (`InboxSplit`): its widths, a way to
/// have the list step aside while the panel needs the room, and the inspector column it shows in.
struct PanelRoom {
    /// The split view's whole width, list and thread: steady while the list slides.
    let window: CGFloat
    /// The list beside the thread, or the list stepped aside for the panel; 0 when the person
    /// hid it, or there is none.
    let list: CGFloat
    /// Each time the person brought the list back over a panel that needed its room.
    let reclaimed: Int
    /// Each time the system closed the inspector column itself.
    let dismissed: Int
    let yield: (Bool) -> Void
    /// Where the panel goes, for the thread's ⋯ menu, panel button and keys.
    let place: Binding<PanelPlace>
    /// The inspector column's widths wherever the panel has room, shown or not.
    let column: Binding<PanelColumnWidth?>
    /// The panel shows its column.
    let shown: Binding<Bool>
}

/// The inspector column's widths: the person's own, inside what leaves the thread its share.
struct PanelColumnWidth: Equatable {
    let min: CGFloat
    let ideal: CGFloat
    let max: CGFloat
}

extension EnvironmentValues {
    @Entry var panelRoom: PanelRoom?
    /// Where the open thread's side panel goes; `.none` keeps its tools over the thread.
    @Entry var panelPlace = PanelPlace.none
}

/// Which part of the panel a view is: the decisions, beside the thread's stack and always there,
/// or the column the inspector shows.
enum PanelPart { case state, column }

/// The open thread's side panel (iPad, a wide window), in the split view's inspector: a trailing
/// column with its own bar, beside the thread, that the person resizes by its edge. Its tabs and
/// width are the thread's (`ThreadPanels`); where it goes is the window's (`PanelPlace`). With no
/// room it doesn't show and the thread's tools open over it as on a phone.
struct ThreadSidePanel: View {
    @Bindable var model: ClientModel
    let threadId: String
    let part: PanelPart
    let openThread: (String) -> Void

    var body: some View {
        switch part {
        case .state: PanelState(model: model, threadId: threadId)
        case .column: PanelColumn(model: model, threadId: threadId, openThread: openThread)
        }
    }
}

/// Decides where the panel goes and whether the column shows, without drawing anything.
private struct PanelState: View {
    @Bindable var model: ClientModel
    let threadId: String
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.panelRoom) private var room

    private var view: PanelView? { model.panels.views[threadId] }
    private var place: PanelPlace {
        guard let view, let room, room.window > 0 else { return .none }
        // The thread's column as it would be with the list showing, from widths that hold still
        // while the list slides in or out.
        return PanelPlace.of(regular: sizeClass == .regular, width: room.window - room.list, list: room.list, limits: view.limits)
    }
    private var column: PanelColumnWidth? {
        guard let view, place != .none, let room else { return nil }
        // Its column once shown: the whole window when the list steps aside for it.
        let detail = place == .yield ? room.window : room.window - room.list
        let low = CGFloat(view.limits.min)
        return PanelColumnWidth(min: low, ideal: PanelPlace.width(size: view.size, column: detail, limits: view.limits),
                                max: max(low, detail - CGFloat(view.limits.keep)))
    }

    var body: some View {
        Color.clear.frame(width: 0, height: 0).accessibilityHidden(true)
            .onChange(of: place, initial: true) { _, now in room?.place.wrappedValue = now }
            .onChange(of: column, initial: true) { _, now in room?.column.wrappedValue = now }
            .onChange(of: view?.open == true && view?.shown != nil && place != .none, initial: true) { _, now in
                room?.shown.wrappedValue = now
            }
            // The list steps aside while a panel that needs its room shows, and comes back after.
            .onChange(of: place == .yield && view?.open == true, initial: true) { _, wants in room?.yield(wants) }
            // The person brought the list back over it, or the system closed the column: the
            // panel gives way.
            .onChange(of: room?.reclaimed ?? 0) { _, _ in
                if place == .yield, view?.open == true { model.panel(threadId, ["op": "panel", "open": false]) }
            }
            .onChange(of: room?.dismissed ?? 0) { _, _ in
                if view?.open == true { model.panel(threadId, ["op": "panel", "open": false]) }
            }
            .task(id: threadId) { if sizeClass == .regular { model.panel(threadId) } }
            .onChange(of: sizeClass) { _, now in if now == .regular { model.panel(threadId) } }
    }
}

/// The column: the tab strip, then the tab's screen with its own bar and stack. The width the
/// person drags the column to is kept for this thread once the drag settles.
private struct PanelColumn: View {
    @Bindable var model: ClientModel
    let threadId: String
    let openThread: (String) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var width: CGFloat = 0

    private var view: PanelView? { model.panels.views[threadId] }
    /// The thread the panel's screens read: the one the client shows, once it is this one.
    private var thread: ThreadModel? { model.thread.flatMap { $0.id == threadId ? $0 : nil } }
    private var motion: Animation { reduceMotion ? AceTheme.Motion.standardCurve : AceTheme.Motion.spring }

    var body: some View {
        Group {
            if let view, let thread { panel(view, thread: thread) }
            else { AceTheme.Colours.background }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width.rounded() } action: { width = $0 }
        // Saved once the edge stops moving, not on every frame of the drag.
        .task(id: width) {
            guard width > 0, let view, abs(Double(width) - view.size) >= 1 else { return }
            try? await Task.sleep(for: .milliseconds(400))
            if !Task.isCancelled { model.panel(threadId, ["op": "size", "size": Double(width)]) }
        }
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
                             mention: model.canOperate ? { model.panels.mention(threadId, path: $0) } : nil)
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
