import SwiftUI
import UniformTypeIdentifiers

/// The side panel's tabs, one line at its top: each tab's title (the one showing on a flat fill),
/// a close button on every tab that isn't pinned, then + (open a tool) and ⋯ (what can be done to
/// the tab showing: pin, move, close, close the others, reopen the last closed, hide the panel).
/// Dragging a tab reorders it; a tab's context menu repeats the ⋯ menu's actions for that tab.
/// Every action goes to the shared rules (`ClientModel.panel`); the strip only draws their answer.
struct PanelTabStrip: View {
    let view: PanelView
    let act: ([String: Any]) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The order shown while a drag is under way, until the bridge sends the order it settled.
    @State private var drag = TabDrag()

    private var tabs: [PanelView.Tab] {
        guard let order = drag.order else { return view.tabs }
        let byKey = Dictionary(uniqueKeysWithValues: view.tabs.map { ($0.key, $0) })
        let ordered = order.compactMap { byKey[$0] }
        return ordered.count == view.tabs.count ? ordered : view.tabs
    }
    private var motion: Animation { reduceMotion ? AceTheme.Motion.standardCurve : AceTheme.Motion.spring }

    var body: some View {
        HStack(spacing: AceTheme.Spacing.none) {
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: AceTheme.Spacing.xs) {
                        ForEach(tabs) { tab in
                            PanelTabItem(tab: tab, shown: tab.key == view.shown?.key, dragging: drag.dragging == tab.key,
                                         activate: { act(["op": "activate", "key": tab.key]) },
                                         close: { act(["op": "close", "key": tab.key]) })
                                .contextMenu { tabActions(tab) }
                                .onDrag {
                                    drag.begin(tab.key, order: view.tabs.map(\.key))
                                    return NSItemProvider(object: tab.key as NSString)
                                }
                                .onDrop(of: [.plainText], delegate: TabDrop(target: tab, tabs: view.tabs, drag: drag, motion: motion, drop: drop))
                                .id(tab.key)
                        }
                    }
                    .padding(.horizontal, AceTheme.Spacing.sm)
                }
                .onChange(of: view.shown?.key, initial: true) { _, key in
                    guard let key else { return }
                    withAnimation(reduceMotion ? nil : AceTheme.Motion.standardCurve) { proxy.scrollTo(key) }
                }
            }
            openMenu
            tabMenu
        }
        .frame(height: AceTheme.Dimensions.touchTarget)
        // The order the bridge settled replaces the one shown while dragging.
        .onChange(of: view.tabs.map(\.key)) { _, _ in if drag.dragging == nil { drag.order = nil } }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Panel tabs")
    }

    /// + : every tool the panel can hold; the ones open already show a check and go to their tab.
    private var openMenu: some View {
        Menu {
            ForEach(view.tools) { tool in
                Button { act(["op": "open", "kind": tool.kind]) } label: {
                    if tool.open { Label(tool.label, systemImage: "checkmark") } else { Text(tool.label) }
                }
            }
        } label: {
            AceIcon(.plus, size: 16).foregroundStyle(AceTheme.Colours.foreground)
                .frame(width: AceTheme.Dimensions.touchTarget, height: AceTheme.Dimensions.touchTarget)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Open a tool")
        .accessibilityIdentifier("panel.open")
    }

    /// ⋯ : what can be done to the tab showing, and to the panel.
    private var tabMenu: some View {
        Menu {
            if let shown = view.shown { tabActions(shown) }
            Section {
                Button("Reopen closed tab") { act(["op": "reopen"]) }
                    .disabled(!view.canReopen)
                    .accessibilityIdentifier("panel.reopen")
                Button("Hide panel") { act(["op": "panel", "open": false]) }
                    .accessibilityIdentifier("panel.hide")
            }
        } label: {
            AceIcon(.dotsThree, size: 20).foregroundStyle(AceTheme.Colours.foreground)
                .frame(width: AceTheme.Dimensions.touchTarget, height: AceTheme.Dimensions.touchTarget)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Tab options")
        .accessibilityIdentifier("panel.menu")
    }

    @ViewBuilder private func tabActions(_ tab: PanelView.Tab) -> some View {
        let index = view.tabs.firstIndex(of: tab) ?? 0
        Section {
            Button(tab.pinned ? "Unpin tab" : "Pin tab") { act(["op": "pin", "key": tab.key, "pinned": !tab.pinned]) }
                .accessibilityIdentifier("panel.pin")
            Button("Move left") { act(["op": "move", "key": tab.key, "to": index - 1]) }
                .disabled(!canMove(tab, by: -1))
            Button("Move right") { act(["op": "move", "key": tab.key, "to": index + 1]) }
                .disabled(!canMove(tab, by: 1))
        }
        Section {
            if !tab.pinned {
                Button("Close tab") { act(["op": "close", "key": tab.key]) }
                    .accessibilityIdentifier("panel.close")
            }
            Button("Close other tabs") { act(["op": "closeOthers", "key": tab.key]) }
                .disabled(!view.tabs.contains { !$0.pinned && $0.key != tab.key })
                .accessibilityIdentifier("panel.closeOthers")
        }
    }

    /// A tab moves only among its own group: pinned tabs stay first.
    private func canMove(_ tab: PanelView.Tab, by step: Int) -> Bool {
        guard let index = view.tabs.firstIndex(of: tab), view.tabs.indices.contains(index + step) else { return false }
        return view.tabs[index + step].pinned == tab.pinned
    }

    private func drop(_ key: String, at index: Int) {
        act(["op": "move", "key": key, "to": index])
    }
}

/// One tab: its title, and a close button unless it is pinned.
private struct PanelTabItem: View {
    let tab: PanelView.Tab
    let shown: Bool
    let dragging: Bool
    let activate: () -> Void
    let close: () -> Void

    var body: some View {
        HStack(spacing: AceTheme.Spacing.none) {
            Button(action: activate) {
                Text(tab.title)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .subheadline)
                    .fontWeight(shown ? .medium : .regular)
                    .foregroundStyle(shown ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
                    .lineLimit(1)
                    .padding(.leading, AceTheme.Spacing.md)
                    .padding(.trailing, tab.pinned ? AceTheme.Spacing.md : AceTheme.Spacing.xs)
                    .frame(maxHeight: .infinity)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(tab.title)
            .accessibilityAddTraits(shown ? .isSelected : [])
            .accessibilityIdentifier("panel.tab.\(tab.kind)")
            if !tab.pinned {
                Button(action: close) {
                    AceIcon(.x, size: 12).foregroundStyle(AceTheme.Colours.subtleForeground)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.trailing, AceTheme.Spacing.xs)
                .accessibilityLabel("Close \(tab.title)")
                .accessibilityIdentifier("panel.tab.\(tab.kind).close")
            }
        }
        .frame(height: 32)
        .background { if shown { Capsule().fill(AceTheme.Colours.fill) } }
        .contentShape(Capsule())
        .opacity(dragging ? 0.4 : 1)
        // A 44-point target: the strip's full height.
        .frame(height: AceTheme.Dimensions.touchTarget)
        .contentShape(Rectangle())
        .hoverEffect(.highlight)
    }
}

/// The drag under way: which tab, and the order shown meanwhile. A drag let go anywhere but on
/// a tab (or cancelled) leaves through one last exit; with no tab entered soon after, the tabs
/// spring back to the order the bridge has.
@MainActor @Observable private final class TabDrag {
    var order: [String]?
    var dragging: String?
    @ObservationIgnored private var visits = 0

    func begin(_ key: String, order: [String]) { dragging = key; self.order = order; visits += 1 }
    func entered() { visits += 1 }
    func exited(motion: Animation) {
        visits += 1
        let visit = visits
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(350))
            guard let self, self.visits == visit, self.dragging != nil else { return }
            withAnimation(motion) { self.order = nil; self.dragging = nil }
        }
    }
    func dropped() { dragging = nil; visits += 1 }
}

/// Reorders while a tab is dragged over the others: the order shown moves at once, springing,
/// and the drop sends the one move. A tab stays among its own group (pinned first).
private struct TabDrop: DropDelegate {
    let target: PanelView.Tab
    let tabs: [PanelView.Tab]
    let drag: TabDrag
    let motion: Animation
    let drop: (String, Int) -> Void

    func dropEntered(info: DropInfo) {
        drag.entered()
        guard let dragging = drag.dragging, dragging != target.key, var current = drag.order,
              let from = current.firstIndex(of: dragging), let to = current.firstIndex(of: target.key),
              tabs.first(where: { $0.key == dragging })?.pinned == target.pinned else { return }
        current.remove(at: from)
        current.insert(dragging, at: to)
        withAnimation(motion) { drag.order = current }
    }
    func dropExited(info: DropInfo) { drag.exited(motion: motion) }
    func dropUpdated(info: DropInfo) -> DropProposal? { DropProposal(operation: .move) }
    func performDrop(info: DropInfo) -> Bool {
        guard let dragging = drag.dragging, let index = drag.order?.firstIndex(of: dragging) else { return false }
        drag.dropped()
        drop(dragging, index)
        return true
    }
}
