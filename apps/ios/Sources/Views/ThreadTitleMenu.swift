import SwiftUI

/// What the thread's system title shows and opens, as a document's title does in the system's
/// own apps. The bar draws the title, and under it (`subtitle`) where the thread is and what
/// runs it: "billing-reconciliation-service · Opus 5.5 · Med"; the system cuts it to the room
/// the bar leaves. A chat has no project and shows the model alone; without a model to change
/// (view only, archived) it reads "project · branch". The title's menu (`toolbarTitleMenu`):
/// the project's mark, name and branch first (opening Work), then Model, effort and speed (one
/// sheet for all three) and Access as a submenu, then the thread's own actions.
///
/// It redraws only when what it shows changes (`==`): a menu rebuilt while open drops the item
/// under the finger, and the thread's row changes many times a second while it works.
struct ThreadTitleMenu: View, Equatable {
    struct ModelLine: Equatable {
        let provider: String?
        let name: String
        /// "Med", "Med · Fast"; nil when the model has nothing to tune.
        let tune: String?
        /// A switch not in effect yet: why, shown under the menu's Model row.
        let note: String?
        let queued: Bool
    }
    let title: String
    let place: String
    /// The thread's project and its mark; empty for a chat.
    var project = ""
    var projectLook: ProjectMarkLook? = nil
    /// The project's initials and its tint (1 to 12) from its row, drawn as the web draws them.
    var projectInitials = ""
    var projectTint: Int? = nil
    /// "Started by Claude" when an outside app started the thread (ADR 0122): it heads the menu.
    var startedBy: String? = nil
    @Environment(\.colorScheme) private var scheme
    /// Nil where the model can't be changed here.
    var model: ModelLine? = nil
    var access: ThreadAccessRow? = nil
    var canRename = false
    var canRetitle = false
    var actions = ThreadTitleActions()
    var openModel: () -> Void = {}
    var setAccess: (String) -> Void = { _ in }
    var rename: () -> Void = {}
    var retitle: () -> Void = {}
    /// The checkout's sheet: branch, worktree, pull request. Nil where there is none to open.
    var openWork: (() -> Void)? = nil

    /// The line under the title: the project and the model with its tuning, the model alone for
    /// a chat, or "project · branch" where the model can't be changed.
    var subtitle: String {
        guard let model else { return place }
        return [project, Self.modelWords(model)].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// Whether the title has anything to do: without, its menu says where the thread is.
    var hasMenu: Bool { model != nil || canRename || canRetitle || openWork != nil || !actions.isEmpty || startedBy != nil }

    var body: some View {
        if hasMenu {
            items
        } else {
            Section { Text(place.isEmpty ? title : place) }
        }
    }

    @ViewBuilder private var items: some View {
        if let startedBy { Section { Text(startedBy) } }
        // Where the thread is, first: the project's mark, its name and the branch under it,
        // opening the checkout's sheet. A menu's header draws no image, so this is its row.
        if let openWork, !place.isEmpty {
            Section {
                Button(action: openWork) {
                    Text(project.isEmpty ? place : project)
                    if !placeDetail.isEmpty { Text(placeDetail) }
                    projectImage
                }
                .accessibilityIdentifier("thread.title.work")
            }
        }
        if let model {
            Section {
                // A menu row's title, subtitle and icon: the model and its tuning in effect.
                Button(action: openModel) {
                    Text("Model, effort and speed…"); Text(model.note ?? Self.modelWords(model)); Image(ace: .cpu)
                }
                .accessibilityIdentifier("thread.title.model")
                if let access, access.state != "none", !access.choices.isEmpty { accessMenu(access) }
            } header: {
                if openWork == nil, !place.isEmpty { Text(place) }
            }
        }
        if canRename || canRetitle {
            Section {
                if canRename { Button("Rename…", ace: .pencilSimple, action: rename).accessibilityIdentifier("thread.rename") }
                if canRetitle { Button("Name from first message", ace: .sparkle, action: retitle).accessibilityIdentifier("thread.retitle") }
            } header: {
                // Where there is no model section, the checkout still heads the menu.
                if model == nil, openWork == nil, !place.isEmpty { Text(place) }
            }
        }
        Section {
            if let fork = actions.fork { Button("Fork from the last turn", ace: .gitFork, action: fork).accessibilityIdentifier("thread.title.fork") }
            if let copy = actions.copyLink { Button("Copy link", ace: .link, action: copy).accessibilityIdentifier("thread.title.copyLink") }
        }
        if let settle = actions.settle {
            Section {
                Button(settle.label, ace: settle.settled ? .arrowUUpLeft : .check, action: settle.run)
                    .accessibilityIdentifier("thread.title.settle")
            }
        }
    }

    /// What follows the project in "project · branch": the branch, or the machine.
    private var placeDetail: String {
        let lead = "\(project) · "
        guard !project.isEmpty, place.hasPrefix(lead) else { return "" }
        return String(place.dropFirst(lead.count))
    }
    /// The same mark as a menu row draws it: rendered to a picture in its own colours.
    private var projectImage: Image {
        if let image = ProjectMark.image(initials: projectInitials, look: projectLook,
                                         tint: ProjectTint.of(look: projectLook, tint: projectTint), scheme: scheme) {
            return Image(uiImage: image)
        }
        return Image(ace: .folderSimple)
    }

    private func accessMenu(_ access: ThreadAccessRow) -> some View {
        Menu {
            Picker("Access", selection: Binding(get: { access.selected ?? "" }, set: { mode in if mode != access.selected { setAccess(mode) } })) {
                ForEach(access.choices) { choice in
                    Text(choice.label).tag(choice.mode)
                }
            }
            .pickerStyle(.inline)
        } label: {
            let note = access.pending == true ? "Applies at the agent's next turn" : access.stricter
            let current = access.choices.first { $0.mode == access.selected }?.label ?? access.label ?? ""
            Text("Access"); Text(note ?? current); Image(ace: .shield)
        }
        .accessibilityIdentifier("thread.title.access")
    }

    /// "Opus 5.5 · Med": the model and its tuning as one run of words, cut at its end.
    private static func modelWords(_ model: ModelLine) -> String {
        model.tune.map { "\(model.name) · \($0)" } ?? model.name
    }

    nonisolated static func == (lhs: ThreadTitleMenu, rhs: ThreadTitleMenu) -> Bool {
        lhs.title == rhs.title && lhs.place == rhs.place && lhs.project == rhs.project && lhs.projectLook == rhs.projectLook
            && lhs.projectInitials == rhs.projectInitials && lhs.projectTint == rhs.projectTint
            && lhs.startedBy == rhs.startedBy
            && lhs.model == rhs.model && lhs.access == rhs.access
            && lhs.canRename == rhs.canRename && lhs.canRetitle == rhs.canRetitle && lhs.actions == rhs.actions
            && (lhs.openWork == nil) == (rhs.openWork == nil)
    }
}
