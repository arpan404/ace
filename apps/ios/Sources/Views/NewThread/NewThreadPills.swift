import SwiftUI

/// One pill of New thread's top row: a capsule in the fill surface with its words and a quiet
/// caret, its touch area a full 44 points tall. The project leads in full ink; the rest are muted.
struct NewThreadPill<Label: View>: View {
    var primary = false
    @ViewBuilder var label: () -> Label
    var body: some View {
        HStack(spacing: AceDesign.Space.tight) {
            label().lineLimit(1)
            AceIcon(.caretDown, size: AceDesign.Size.caret, relativeTo: .caption)
                .font(.caption2.weight(.semibold)).foregroundStyle(AceTheme.Colours.subtleForeground)
        }
        .aceFont(NewThreadStyle.chip, relativeTo: .subheadline)
        .foregroundStyle(primary ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
        .padding(.horizontal, AceDesign.Space.row)
        .frame(minHeight: ComposerControlRow.height)
        .background(AceTheme.Colours.fill, in: AceShape.capsule)
        .padding(.vertical, (AceDesign.Size.tap - ComposerControlRow.height) / 2)
        .contentShape(Rectangle())
    }
}

/// What the pills say and open. The sheet reads them from the draft and the bridge's reads.
struct NewThreadPillsModel {
    struct Machine: Identifiable { let id: String; let name: String; let canOperate: Bool }
    var project: String
    var machines: [Machine]
    var machineId: String?
    var provider: String?
    var model: String
    var loadingModel: Bool
    /// "High", "Med · Fast"; nil when the model has nothing to tune.
    var tune: String?
    /// Where it runs, when the project is a folder with branches; nil for a chat or a PR's worktree.
    var place: Place?
    var access: ComposeAccess?

    struct Place {
        var worktree: Bool
        /// Why it can't have a worktree ("Not a Git repository").
        var noWorktree: String?
        var reading: Bool
        var bases: [ComposeBase]
        var base: ComposeBaseRef?
    }
}

/// Project, machine (only when there's more than one), model, its effort, where it runs and
/// access: the choices a start makes, as pills that wrap.
struct NewThreadPills: View {
    let model: NewThreadPillsModel
    let chooseProject: () -> Void
    let chooseMachine: (String) -> Void
    let chooseModel: () -> Void
    let chooseTune: () -> Void
    let chooseWorktree: (Bool) -> Void
    let chooseBase: (ComposeBaseRef) -> Void
    let chooseAccess: (String) -> Void
    @State private var choosingAccess = false

    var body: some View {
        ChipFlow(spacing: AceDesign.Space.related) {
            Button(action: chooseProject) { NewThreadPill(primary: true) { Text(model.project) } }
                .buttonStyle(.plain)
                .accessibilityLabel("Project").accessibilityValue(model.project)
                .accessibilityIdentifier("newThread.project")
            if model.machines.count > 1 { machine }
            Button(action: chooseModel) {
                NewThreadPill {
                    HStack(spacing: AceDesign.Space.tight) {
                        if model.loadingModel { ProgressView().controlSize(.mini) }
                        else if let provider = model.provider { ProviderMark(provider: provider, size: AceDesign.Size.metaIcon) }
                        Text(model.model)
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Model").accessibilityValue(model.model)
            .accessibilityIdentifier("newThread.agent")
            if let tune = model.tune {
                Button(action: chooseTune) { NewThreadPill { Text(tune) } }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Effort and speed").accessibilityValue(tune)
                    .accessibilityIdentifier("newThread.tune")
            }
            if let place = model.place { placePill(place) }
            if let access = model.access, !access.choices.isEmpty { accessPill(access) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var machine: some View {
        Menu {
            Picker("Machine", selection: Binding(get: { model.machineId ?? "" }, set: { chooseMachine($0) })) {
                ForEach(model.machines) { machine in
                    Text(machine.canOperate ? machine.name : "\(machine.name) · View only").tag(machine.id)
                }
            }
        } label: {
            NewThreadPill { Text(model.machines.first { $0.id == model.machineId }?.name ?? "Machine") }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Machine").accessibilityValue(model.machines.first { $0.id == model.machineId }?.name ?? "")
        .accessibilityIdentifier("newThread.machine")
    }

    /// "Current branch", or "Worktree from main": one menu for both choices, as the web's strip
    /// keeps them together.
    private func placePill(_ place: NewThreadPillsModel.Place) -> some View {
        let worktree = place.worktree && place.noWorktree == nil
        let selected = place.base ?? place.bases.first?.base
        let baseLabel = place.bases.first { $0.base == selected }?.label
        let label = worktree ? (baseLabel.map { "Worktree from \($0)" } ?? "Worktree") : "Current branch"
        return Menu {
            Picker("Where it runs", selection: Binding(get: { worktree }, set: { chooseWorktree($0) })) {
                Text("Current branch").tag(false)
                Text("New worktree").tag(true)
            }
            .disabled(place.noWorktree != nil)
            if worktree, !place.bases.isEmpty {
                Picker("Starts from", selection: Binding<ComposeBaseRef?>(get: { selected }, set: { if let base = $0 { chooseBase(base) } })) {
                    ForEach(place.bases) { base in
                        let tag: ComposeBaseRef? = base.base
                        Text(base.title).tag(tag)
                    }
                }
                .pickerStyle(.menu)
            }
            if let reason = place.noWorktree { Text(reason) }
        } label: {
            NewThreadPill { Text(label) }
        }
        .buttonStyle(.plain)
        .disabled(place.reading && place.bases.isEmpty && place.noWorktree == nil)
        .accessibilityLabel("Where it runs").accessibilityValue(label)
        .accessibilityIdentifier("newThread.worktree")
    }

    private func accessPill(_ access: ComposeAccess) -> some View {
        let label = access.choices.first { $0.mode == access.selected }?.label ?? "Access"
        return Button { choosingAccess = true } label: { NewThreadPill { Text(label) } }
            .buttonStyle(.plain)
            .accessibilityLabel("Access").accessibilityValue(label)
            .accessibilityIdentifier("newThread.access")
            .sheet(isPresented: $choosingAccess) {
                AccessSheet(selected: access.selected,
                            items: access.choices.map { AccessItem(mode: $0.mode, label: $0.label, description: $0.description, attention: $0.attention) },
                            note: access.problem ?? access.stricter, identifier: "newThread.access") { mode in
                    choosingAccess = false
                    if mode != access.selected { chooseAccess(mode) }
                }
            }
    }
}
