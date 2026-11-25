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
    /// Some file in the editor has a draft, so Back stays hidden.
    let locked: Bool
    /// The navigation bar's title while the files draw their own bars.
    let title: String
    /// Nil in compact width, where the editor has one group.
    let split: Split?
    /// The file's draft, read when it is drawn: an earlier editor of it may have just gone.
    let draft: () -> EditorDraft?
    /// Editing began from this snapshot.
    let began: (FileContent) -> Void
    /// The text changed from the file (or back).
    let dirtied: (Bool, FileContent) -> Void
    /// Save or merge moved the draft onto a new machine snapshot.
    let rebased: (FileContent, String) -> Void
    /// The editor went with this text in it.
    let left: (String) -> Void
    /// Saved or discarded.
    let ended: () -> Void
    /// Show another open file in this group.
    let pick: (String) -> Void
    /// The file was renamed or moved to this path.
    let renamed: (String) -> Void
    /// The file was deleted: its tab closes (and in compact width the editor leaves).
    let removed: () -> Void
    let focus: () -> Void
}

/// The editor's drafts, shared by every group's editor (`EditorDrafts`).
@MainActor @Observable final class EditorDraftStore {
    var drafts = EditorDrafts()
}

/// The checkout's folder on the computer (`root` request).
private struct FilesRoot: Decodable { let root: String? }

/// The editor: the file opened, among the files open in this checkout. On an iPad in regular
/// width it holds up to two groups side by side, each with its own tabs (`EditorGroupLayout`),
/// split from a file's menu, a tab's menu, or by dragging a tab to the right edge. On a phone
/// and in compact width it is one file with the system bar, as `FileScreen` always was, and the
/// split comes back with the room. Drafts live here, by file, so no move, close or change of
/// width loses one; the groups are kept per checkout for the next time.
struct EditorGroups: View {
    let model: ClientModel
    let scope: FilesScope
    let target: FileTarget
    let mention: ((ComposerMention) -> Void)?
    var deleted: ((FileStrip) -> Void)?
    var openFolder: ((String) -> Void)?
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.dismiss) private var dismiss
    @State private var layout = EditorGroupLayout()
    @State private var drafts = EditorDraftStore()
    /// Where the layout is stored, once the checkout's folder is known.
    @State private var key: String?
    /// Tabs with unsaved changes waiting on Discard before they close.
    @State private var discarding: [String] = []
    /// Leaving on its own (a file deleted on a phone): an emptied layout doesn't dismiss again.
    @State private var leaving = false

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
        .navigationBarBackButtonHidden(drafts.drafts.editing)
        .toolbar {
            if regular {
                ToolbarItem(placement: .topBarTrailing) {
                    OpenFilesButton(model: model, scope: scope) { picked in change { $0.open(picked) } }
                }
            }
        }
        .confirmationDialog(discardTitle, isPresented: Binding(get: { !discarding.isEmpty }, set: { if !$0 { discarding = [] } }),
                            titleVisibility: .visible) {
            Button("Discard changes", role: .destructive) { discard() }
            Button("Keep editing", role: .cancel) { discarding = [] }
        }
        .onAppear {
            if layout.groups.isEmpty { layout.open(target.path) }
        }
        .task { await restore() }
        .onChange(of: open) { old, now in
            guard let now else { return }
            let held = drafts.drafts.unsaved
            layout.sync(open: now, previous: old, keep: target.path, held: held)
            // Closed elsewhere while it has changes: it stays open here, and on the computer.
            for path in held where !now.contains(path) { model.fileOpened(scope, path) }
        }
        .onChange(of: layout) { _, now in
            if let key { UserDefaults.standard.set(now.stored, forKey: key) }
            if key != nil, !leaving, now.groups.isEmpty { dismiss() }
        }
    }

    private var discardTitle: String {
        discarding.count == 1 ? "Discard your changes to \(FileActions.name(discarding[0]))?" : "Discard your changes to \(discarding.count) files?"
    }

    private func pane(_ group: EditorGroupLayout.Group) -> some View {
        let focused = group.id == shown.focused
        return VStack(spacing: AceTheme.Spacing.none) {
            if regular {
                EditorTabStrip(group: group, focused: focused, unsaved: drafts.drafts.unsaved,
                               other: layout.other(than: group.id) != nil, canSplit: { layout.canSplit($0) },
                               activate: { path in change { $0.open(path) } },
                               split: { path in change { $0.split(path) } },
                               close: { paths in close(paths) })
            }
            FileScreen(model: model, scope: scope, target: fileTarget(group.active), mention: mention, deleted: deleted,
                       openFolder: openFolder, slot: slot(group, focused: focused))
                .id(group.active)
        }
        .frame(maxWidth: .infinity)
        // Any touch in a group (its tabs, its bar, its text) makes it the one files open in.
        .simultaneousGesture(TapGesture().onEnded { focus(group.id) })
    }

    private func slot(_ group: EditorGroupLayout.Group, focused: Bool) -> EditorSlot {
        let path = group.active
        let two = layout.other(than: group.id) != nil
        let split = regular
            ? EditorSlot.Split(label: two ? "Move to other group" : "Split right", icon: two ? .arrowsLeftRight : .sidebarSimple,
                               enabled: two || layout.canSplit(path), run: { change { $0.split(path) } })
            : nil
        let store = drafts
        return EditorSlot(pane: regular, focused: focused, locked: store.drafts.editing, title: "Editor", split: split,
                          draft: { store.drafts[path] },
                          began: { base in store.drafts.begin(path, base: base) },
                          dirtied: { dirty, base in store.drafts.mark(path, dirty: dirty, base: base) },
                          rebased: { base, text in store.drafts.rebase(path, onto: base, text: text) },
                          left: { text in store.drafts.left(path, text: text) },
                          ended: { store.drafts.end(path) },
                          pick: { picked in change { $0.open(picked) } },
                          renamed: { destination in
                              store.drafts.rename(path, to: destination)
                              change { $0.rename(path, to: destination) }
                          },
                          removed: { removed(path) },
                          focus: { focus(group.id) })
    }

    /// The file a tab shows: the one this editor was opened for keeps its line and change mark.
    private func fileTarget(_ path: String) -> FileTarget {
        path == target.path ? target : FileTarget(path: path)
    }

    /// The checkout's stored groups, with the file being opened shown in them.
    private func restore() async {
        guard key == nil else { return }
        model.watchFileMemory(scope)
        let found = try? await model.files(scope, ["op": "root"], as: FilesRoot.self, timeout: .seconds(3))
        let key = EditorGroupLayout.storageKey(machine: model.hostId, root: found?.root ?? nil, scope: scope.memoryKey)
        var next = EditorGroupLayout.restore(UserDefaults.standard.string(forKey: key) ?? "")
        if target.side, regular { next.openToSide(target.path) } else { next.open(target.path) }
        // A file opened in the moment before the store was read stays open, and showing.
        for path in layout.groups.flatMap(\.tabs) where next.group(of: path) == nil { next.open(path) }
        if let shown = layout.shown { next.open(shown) }
        if let open { next.sync(open: open, previous: nil, keep: target.path, held: drafts.drafts.unsaved) }
        self.key = key
        layout = next
    }

    private func change(_ edit: (inout EditorGroupLayout) -> Void) {
        var next = layout
        edit(&next)
        guard next != layout else { return }
        withAnimation(.default) { layout = next }
    }

    private func focus(_ id: String) {
        if layout.focused != id { change { $0.focus(id) } }
    }

    /// Every close goes through here: a tab with unsaved changes asks before they're discarded.
    private func close(_ paths: [String]) {
        let closing = drafts.drafts.closing(paths)
        for path in closing.now { closeNow(path) }
        discarding = closing.ask
    }

    private func discard() {
        for path in discarding {
            drafts.drafts.end(path)
            closeNow(path)
        }
        discarding = []
    }

    private func closeNow(_ path: String) {
        drafts.drafts.closed(path)
        change { $0.close(path) }
        model.fileClosed(scope, path)
    }

    /// A deleted file's tab closes. On a phone or in compact width the editor goes back to the
    /// tree, where Undo shows, as a file screen always did.
    private func removed(_ path: String) {
        drafts.drafts.end(path)
        if regular {
            closeNow(path)
        } else {
            leaving = true
            closeNow(path)
            dismiss()
        }
    }

    /// A tab let go over the editor: on the right third of a lone group it splits right; over
    /// the other group it moves there. Its draft goes with it.
    private func dropped(_ paths: [String], at x: CGFloat, width: CGFloat) -> Bool {
        guard regular, width > 0, let path = paths.first, let from = layout.group(of: path) else { return false }
        let groups = layout.groups
        if groups.count == 1 {
            guard x > width * 2 / 3, layout.canSplit(path) else { return false }
            change { $0.split(path) }
            return true
        }
        let onto = groups[x < width / 2 ? 0 : 1]
        guard onto.id != from.id else { return false }
        change { $0.move(path, to: onto.id) }
        return true
    }
}
