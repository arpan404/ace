import SwiftUI

/// The thread's title and the line under it as one tap target that opens one system menu, as a
/// document's title does in the system's own apps. The line reads where the thread is and what
/// runs it: the project's mark and name, then the model and its effort ("▣ ace-next · Opus 5.5 ·
/// Med ⌄"); the project's name is cut first, so the model always reads. A chat has no project and
/// shows the model alone; without a model to change (view only, archived) it reads "project ·
/// branch". The menu: the project's mark, name and branch first (opening Work), then Model (the
/// picker sheet), Effort and Access as submenus, then the thread's own actions.
///
/// It redraws only when what it shows changes (`==`): a menu rebuilt while open drops the item
/// under the finger, and the thread's row changes many times a second while it works.
struct ThreadTitleMenu: View, Equatable {
    struct ModelLine: Equatable {
        let provider: String?
        let name: String
        /// "Med", "Med · Fast"; nil when the model has nothing to tune.
        let tune: String?
        /// A switch not in effect yet: why, read out with it.
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
    @Environment(\.colorScheme) private var scheme
    let status: String?
    var width: CGFloat
    /// Nil where the model can't be changed here.
    var model: ModelLine? = nil
    var tune: TuneRow? = nil
    var access: ThreadAccessRow? = nil
    var canRename = false
    var canRetitle = false
    var actions = ThreadTitleActions()
    var openModel: () -> Void = {}
    var openTune: () -> Void = {}
    var setEffort: (String?) -> Void = { _ in }
    var setSpeed: (String) -> Void = { _ in }
    var setAccess: (String) -> Void = { _ in }
    var rename: () -> Void = {}
    var retitle: () -> Void = {}
    /// The checkout's sheet: branch, worktree, pull request. Nil where there is none to open.
    var openWork: (() -> Void)? = nil

    private var hasMenu: Bool { model != nil || canRename || canRetitle || openWork != nil || !actions.isEmpty }

    var body: some View {
        Group {
            if hasMenu {
                Menu { items } label: { label(chevron: true) }
                    .menuOrder(.fixed)
                    .accessibilityIdentifier("thread.title")
                    .accessibilityHint("Model and thread actions")
            } else {
                label(chevron: false).accessibilityIdentifier("thread.title")
            }
        }
        // UIKit measures principal items at their ideal size: the toolbar proposes a width that
        // leaves equal room for the controls on either side.
        .frame(width: width)
    }

    private func label(chevron: Bool) -> some View {
        VStack(spacing: AceTheme.Spacing.none) {
            Text(title).aceFont(AceDesign.TextRole.navTitle, relativeTo: .subheadline)
                .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
            subtitle(chevron: chevron)
        }
        .frame(width: width)
        // The whole heading is the target: both lines and the space between them.
        .frame(minHeight: AceDesign.Size.tap)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityValue([model.map(Self.spoken), status].compactMap { $0 }.joined(separator: ", "))
    }

    @ViewBuilder private func subtitle(chevron: Bool) -> some View {
        HStack(spacing: AceDesign.Space.tight) {
            if let model {
                if !project.isEmpty {
                    mark
                    Text(project).lineLimit(1).truncationMode(.tail)
                        .foregroundStyle(AceTheme.Colours.subtleForeground)
                    Text(verbatim: "·").foregroundStyle(AceTheme.Colours.subtleForeground).fixedSize().accessibilityHidden(true)
                }
                Text(model.name).lineLimit(1).truncationMode(.middle).layoutPriority(1)
                if let tune = model.tune { Text("· \(tune)").lineLimit(1).fixedSize() }
                if model.queued {
                    AceIcon(.clock, size: AceDesign.Size.rowPin, relativeTo: .caption)
                }
            } else if !place.isEmpty {
                if !project.isEmpty { mark }
                Text(place).lineLimit(1).truncationMode(.middle)
            }
            if chevron {
                AceIcon(.caretDown, size: AceDesign.Size.rowPin, weight: .bold, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.subtleForeground)
                    .accessibilityHidden(true)
            }
        }
        .aceFont(AceDesign.TextRole.navSubtitle, relativeTo: .caption)
        .foregroundStyle(model == nil ? AceTheme.Colours.subtleForeground : AceTheme.Colours.mutedForeground)
    }

    @ViewBuilder private var items: some View {
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
                // A menu row's title, subtitle and icon: the model in effect under "Model".
                Button(action: openModel) {
                    Text("Model"); Text(model.note ?? model.name); Image(ace: .cpu)
                }
                .accessibilityIdentifier("thread.title.model")
                if let tune, !tune.efforts.isEmpty || tune.speeds.count > 1 { effortMenu(tune) }
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
    /// The project's own mark, sized to the subtitle's line.
    private var mark: some View {
        ProjectMark(initials: projectInitials, look: projectLook,
                    tint: ProjectTint.of(look: projectLook, tint: projectTint), size: AceDesign.Size.glyphMeta)
    }
    /// The same mark as a menu row draws it: rendered to a picture in its own colours.
    private var projectImage: Image {
        if let image = ProjectMark.image(initials: projectInitials, look: projectLook,
                                         tint: ProjectTint.of(look: projectLook, tint: projectTint), scheme: scheme) {
            return Image(uiImage: image)
        }
        return Image(ace: .folderSimple)
    }

    /// Effort and speed as the system's own pickers; a level the provider can't change now is
    /// shown, dimmed, with why in its subtitle.
    private func effortMenu(_ tune: TuneRow) -> some View {
        Menu {
            if !tune.efforts.isEmpty {
                Picker("Effort", selection: Binding(get: { tune.effort }, set: { setEffort($0) })) {
                    ForEach(tune.efforts) { Text($0.label).tag($0.id) }
                }
                .pickerStyle(.inline)
                .disabled(!tune.effortReason.isEmpty)
                .accessibilityIdentifier("thread.title.effort.levels")
            }
            if tune.speeds.count > 1 {
                Picker("Speed", selection: Binding(get: { tune.speed }, set: { setSpeed($0) })) {
                    ForEach(tune.speeds) { Text($0.label).tag($0.speed) }
                }
                .pickerStyle(.inline)
                .disabled(!tune.speedReason.isEmpty)
            }
            if tune.canReset {
                Button("Use the model's default") { setEffort(nil) }
            }
        } label: {
            Text("Effort"); Text(effortSubtitle(tune)); Image(ace: .gauge)
        }
        .accessibilityIdentifier("thread.title.effort")
    }

    private func effortSubtitle(_ tune: TuneRow) -> String {
        if tune.pending { return "Applies with your next message" }
        let reason = [tune.effortReason, tune.speedReason].first { !$0.isEmpty }
        return model?.tune ?? reason ?? ""
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

    private static func spoken(_ model: ModelLine) -> String {
        [model.name, model.tune, model.note].compactMap { $0 }.joined(separator: ", ")
    }

    nonisolated static func == (lhs: ThreadTitleMenu, rhs: ThreadTitleMenu) -> Bool {
        lhs.title == rhs.title && lhs.place == rhs.place && lhs.project == rhs.project && lhs.projectLook == rhs.projectLook
            && lhs.projectInitials == rhs.projectInitials && lhs.projectTint == rhs.projectTint
            && lhs.status == rhs.status && lhs.width == rhs.width
            && lhs.model == rhs.model && lhs.tune == rhs.tune && lhs.access == rhs.access
            && lhs.canRename == rhs.canRename && lhs.canRetitle == rhs.canRetitle && lhs.actions == rhs.actions
            && (lhs.openWork == nil) == (rhs.openWork == nil)
    }
}
