import SwiftUI

/// The project's branches, default first, with the system search field: the current one is
/// marked and can't be picked; picking another switches the checkout to it (asking first when
/// uncommitted changes would come along). While the checkout can't move, the list says why.
struct WorkBranchPicker: View {
    @Bindable var model: ClientModel
    let runner: WorkRunner
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    private var work: WorkSummary? { model.sheets.work }
    private var branches: WorkBranches? { model.sheets.branches }
    private var shown: [String] {
        let names = branches?.names ?? []
        let query = search.trimmingCharacters(in: .whitespaces)
        return query.isEmpty ? names : names.filter { $0.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        List {
            if let reason = work?.switchReason {
                Text(reason).foregroundStyle(AceDesign.Ink.muted)
                    .accessibilityIdentifier("work.branches.reason")
            }
            switch branches?.state {
            case "ready":
                ForEach(shown, id: \.self) { name in row(name) }
                if shown.isEmpty { Text("No branch matches").foregroundStyle(AceDesign.Ink.muted) }
                if branches?.truncated == true { Text("More branches on your computer").foregroundStyle(AceDesign.Ink.muted) }
            case "error":
                HStack {
                    Text("Couldn't read the branches.").foregroundStyle(AceTheme.StatusText.failed)
                    Spacer()
                    Button("Try again") { model.sheet(["kind": "work.branches"]) }
                        .buttonStyle(.textAction(.prominent)).accessibilityIdentifier("work.branches.retry")
                }
            default:
                // Rows shaped like branches while they're read, so the list doesn't jump.
                ForEach(0..<4, id: \.self) { _ in Text("feature/branch-name").redacted(reason: .placeholder) }
                    .accessibilityHidden(true)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(AceDesign.Surface.background)
        .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Find a branch")
        .navigationTitle("Switch branch")
        .navigationBarTitleDisplayMode(.inline)
        .aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout)
        .accessibilityIdentifier("work.branches")
    }

    private func row(_ name: String) -> some View {
        let current = name == work?.branch
        let allowed = model.canOperate && work?.switchReason == nil && !current && !runner.running(in: model)
        return Button {
            runner.send(["kind": "switch", "branch": name], model: model)
            dismiss()
        } label: {
            HStack(spacing: AceDesign.Space.related) {
                Text(verbatim: name).aceMonospace(AceDesign.TextRole.rowTitle, relativeTo: .callout)
                    .foregroundStyle(current || allowed ? AceDesign.Ink.primary : AceDesign.Ink.muted)
                    .lineLimit(1).truncationMode(.middle)
                Spacer(minLength: AceDesign.Space.related)
                if current { AceIcon(.check, size: AceDesign.Size.icon, relativeTo: .subheadline).foregroundStyle(AceDesign.Ink.primary) }
            }
            .frame(minHeight: AceDesign.Size.rowLine).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!allowed)
        .listRowSeparatorTint(AceTheme.Colours.separator)
        .listRowBackground(AceDesign.Surface.background)
        .accessibilityAddTraits(current ? .isSelected : [])
        .accessibilityIdentifier("work.branch.\(name)")
    }
}
