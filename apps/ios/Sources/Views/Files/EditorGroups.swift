import SwiftUI

/// What a file needs from the editor group it shows in.
struct EditorSlot {
    /// Split right, or with two groups, Move to other group.
    struct Split {
        let label: String
        let icon: AceIcon.Name
        let enabled: Bool
        let run: () -> Void
    }

    /// Regular width: the file's bar is a row over it, and the navigation bar is the editor's.
    let pane: Bool
    /// The group files open in; only its file answers Go to line's shortcut.
    let focused: Bool
    /// The navigation bar's title while the files draw their own bars.
    let title: String
    /// Nil in compact width, where the editor has one group.
    let split: Split?
    /// Show another open file in this group.
    let pick: (String) -> Void
    /// The file was renamed or moved to this path.
    let renamed: (String) -> Void
    /// The file was deleted: its tab closes.
    let removed: () -> Void
    let editing: (Bool) -> Void
    let focus: () -> Void
}

/// The editor: the file opened, among the files open in this checkout. On an iPad in regular
/// width it holds up to two groups side by side, each with its own tabs (`EditorGroupLayout`),
/// split from a file's menu, a tab's menu, or by dragging a tab to the right edge. On a phone
/// and in compact width it is one file with the system bar, as `FileScreen` always was, and the
/// split comes back with the room. The groups are kept per checkout for the next time.
struct EditorGroups: View {
    let model: ClientModel
    let scope: FilesScope
    let target: FileTarget
    let mention: ((ComposerMention) -> Void)?
    var deleted: ((FileStrip) -> Void)?
    var openFolder: ((String) -> Void)?
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.dismiss) private var dismiss
    @AppStorage private var stored: String
    @State private var layout = EditorGroupLayout()
    @State private var loaded = false
    /// Groups whose file is being edited: their tabs hold still, and the editor can't be left.
    @State private var editing: Set<String> = []

    init(model: ClientModel, scope: FilesScope, target: FileTarget, mention: ((ComposerMention) -> Void)?,
         deleted: ((FileStrip) -> Void)? = nil, openFolder: ((String) -> Void)? = nil) {
        self.model = model
        self.scope = scope
        self.target = target
        self.mention = mention
        self.deleted = deleted
        self.openFolder = openFolder
        _stored = AppStorage(wrappedValue: "", "editor.groups.\(scope.memoryKey)")
    }

    private var regular: Bool { sizeClass == .regular }
    private var shown: EditorGroupLayout { regular ? layout : layout.collapsed }
    private var open: [String]? { model.files.memory[scope.memoryKey]?.open }

    var body: some View {
        GeometryReader { box in
            HStack(spacing: AceTheme.Spacing.none) {
                ForEach(Array(shown.groups.enumerated()), id: \.element.id) { index, group in
                    if index > 0 {
                        Rectangle().fill(AceTheme.Colours.separator).frame(width: AceDesign.Size.hairline)
                    }
                    pane(group)
                }
            }
            .dropDestination(for: String.self) { paths, at in dropped(paths, at: at.x, width: box.size.width) }
        }
        .background(AceTheme.Colours.background)
        .navigationBarBackButtonHidden(!editing.isEmpty)
        .toolbar {
            if regular {
                ToolbarItem(placement: .topBarTrailing) {
                    OpenFilesButton(model: model, scope: scope) { picked in change { $0.open(picked) } }
                }
            }
        }
        .onAppear(perform: load)
        .onChange(of: open) { old, now in
            guard let now else { return }
            layout.sync(open: now, previous: old, keep: target.path)
        }
        .onChange(of: layout) { _, now in
            stored = now.stored ?? ""
            if loaded, now.groups.isEmpty { dismiss() }
        }
    }

    private func pane(_ group: EditorGroupLayout.Group) -> some View {
        let focused = group.id == shown.focused
        return VStack(spacing: AceTheme.Spacing.none) {
            if regular {
                EditorTabStrip(group: group, focused: focused, held: editing.contains(group.id),
                               other: layout.other(than: group.id) != nil, canSplit: { layout.canSplit($0) },
                               activate: { path in change { $0.open(path) } },
                               split: { path in change { $0.split(path) } },
                               close: { path in close(path) })
            }
            FileScreen(model: model, scope: scope, target: fileTarget(group.active), mention: mention, deleted: deleted,
                       openFolder: openFolder, slot: slot(group, focused: focused))
                .id(group.active)
        }
        .frame(maxWidth: .infinity)
    }

    private func slot(_ group: EditorGroupLayout.Group, focused: Bool) -> EditorSlot {
        let path = group.active
        let two = layout.other(than: group.id) != nil
        let split = regular
            ? EditorSlot.Split(label: two ? "Move to other group" : "Split right", icon: two ? .arrowsLeftRight : .sidebarSimple,
                               enabled: two || layout.canSplit(path), run: { change { $0.split(path) } })
            : nil
        return EditorSlot(pane: regular, focused: focused, title: "Editor", split: split,
                          pick: { picked in change { $0.open(picked) } },
                          renamed: { destination in change { $0.rename(path, to: destination) } },
                          removed: { close(path) },
                          editing: { now in if now { _ = editing.insert(group.id) } else { _ = editing.remove(group.id) } },
                          focus: { change { $0.focus(group.id) } })
    }

    /// The file a tab shows: the one this editor was opened for keeps its line and change mark.
    private func fileTarget(_ path: String) -> FileTarget {
        path == target.path ? target : FileTarget(path: path)
    }

    private func load() {
        guard !loaded else { return }
        var next = EditorGroupLayout.restore(stored)
        if target.side, regular { next.openToSide(target.path) } else { next.open(target.path) }
        if let open { next.sync(open: open, previous: nil, keep: target.path) }
        layout = next
        loaded = true
        model.watchFileMemory(scope)
    }

    private func change(_ edit: (inout EditorGroupLayout) -> Void) {
        var next = layout
        edit(&next)
        withAnimation(.default) { layout = next }
    }

    private func close(_ path: String) {
        change { $0.close(path) }
        model.fileClosed(scope, path)
    }

    /// A tab let go over the editor: on the right third of a lone group it splits right; over
    /// the other group it moves there.
    private func dropped(_ paths: [String], at x: CGFloat, width: CGFloat) -> Bool {
        guard regular, width > 0, let path = paths.first, let from = layout.group(of: path) else { return false }
        let groups = layout.groups
        if groups.count == 1 {
            guard x > width * 2 / 3, layout.canSplit(path) else { return false }
            change { $0.split(path) }
            return true
        }
        let onto = groups[x < width / 2 ? 0 : 1]
        guard onto.id != from.id, !editing.contains(from.id) else { return false }
        change { $0.move(path, to: onto.id) }
        return true
    }
}

/// One group's tabs in a line over its file: the file showing on a flat fill (in full ink while
/// the group is the focused one), a close button on each. A tab's menu splits it right or moves
/// it to the other group, and a tab can be dragged to the editor's right edge or the other group.
/// While the group's file is being edited the tabs hold still.
private struct EditorTabStrip: View {
    let group: EditorGroupLayout.Group
    let focused: Bool
    let held: Bool
    let other: Bool
    let canSplit: (String) -> Bool
    let activate: (String) -> Void
    let split: (String) -> Void
    let close: (String) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: AceTheme.Spacing.xs) {
                    ForEach(group.tabs, id: \.self) { path in
                        tab(path)
                            .contextMenu { menu(path) }
                            .draggable(path) { Text(FileActions.name(path)).aceMonospace(AceDesign.TextRole.rowTitle) }
                            .id(path)
                    }
                }
                .padding(.horizontal, AceTheme.Spacing.sm)
            }
            .onChange(of: group.active, initial: true) { _, path in withAnimation { proxy.scrollTo(path) } }
        }
        .frame(height: AceDesign.Size.tap)
        .disabled(held)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Open files")
    }

    private func tab(_ path: String) -> some View {
        let shown = path == group.active
        let name = FileActions.name(path)
        return HStack(spacing: AceTheme.Spacing.none) {
            Button { activate(path) } label: {
                Text(name)
                    .aceMonospace(AceTheme.Typography.caption, relativeTo: .subheadline)
                    .foregroundStyle(shown && focused ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
                    .lineLimit(1)
                    .padding(.leading, AceTheme.Spacing.md)
                    .padding(.trailing, AceTheme.Spacing.xs)
                    .frame(maxHeight: .infinity)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(name)
            .accessibilityAddTraits(shown ? .isSelected : [])
            .accessibilityIdentifier("editor.tab.\(path)")
            Button { close(path) } label: {
                AceIcon(.x, size: AceDesign.Size.caret).foregroundStyle(AceTheme.Colours.subtleForeground)
                    .frame(width: AceDesign.Size.pill, height: AceDesign.Size.pill)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.trailing, AceTheme.Spacing.xs)
            .accessibilityLabel("Close \(name)")
            .accessibilityIdentifier("editor.tab.\(path).close")
        }
        .frame(height: AceDesign.Size.pill)
        .background { if shown { AceDesign.Shape.control.fill(AceTheme.Colours.fill) } }
        .contentShape(AceDesign.Shape.control)
        .frame(height: AceDesign.Size.tap)
        .contentShape(Rectangle())
        .hoverEffect(.highlight)
    }

    @ViewBuilder private func menu(_ path: String) -> some View {
        if other {
            Button("Move to other group", ace: .arrowsLeftRight) { split(path) }
        } else {
            Button("Split right", ace: .sidebarSimple) { split(path) }.disabled(!canSplit(path))
        }
        Button("Close", ace: .x) { close(path) }
        Button("Close others", ace: .xSquare) { for each in group.tabs where each != path { close(each) } }
            .disabled(group.tabs.count < 2)
    }
}
