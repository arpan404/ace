import SwiftUI

/// A bot's profile (docs/design/spade.md §4) as a sheet over its chat: its face and name, where
/// it runs, then Details · Library · Computer as a segmented control, each read from Spade as
/// the sheet opens and again on a pull. The task edits on its own page; the rest is to read.
struct SpadeProfileSheet: View {
    let client: ClientModel
    let agent: String
    let name: String
    @Environment(\.dismiss) private var dismiss
    @State private var part: Part = .details
    @State private var reads = SpadeProfileReads()
    private var profile: SpadeProfile? { reads.profile }
    private var problem: String? { reads.problem }

    enum Part: String, CaseIterable, Identifiable {
        case details = "Details", library = "Library", computer = "Computer"
        var id: String { rawValue }
    }

    var body: some View {
        NavigationStack {
            List {
                head
                if let profile {
                    Section {
                        Picker("Part", selection: $part) {
                            ForEach(Part.allCases) { Text($0.rawValue).tag($0) }
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("spade.profile.part")
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                    switch part {
                    case .details: SpadeProfileDetails(profile: profile, retry: retry, edit: editor)
                    case .library: SpadeProfileLibrary(library: profile.library, name: profile.name, retry: retry)
                    case .computer: SpadeProfileComputer(computer: profile.computer, retry: retry)
                    }
                } else if let problem {
                    ProblemRow(problem, id: "spade.profile.problem") { Task { await load() } }
                } else {
                    SkeletonRows(count: 3).listRowInsets(EdgeInsets())
                }
            }
            .listStyle(.insetGrouped)
            .environment(\.spadeProfileScope, SpadeProfileScope(client: client, agent: agent, name: profile?.name ?? name, machine: profile?.details.machine ?? ""))
            .refreshable { await load() }
            .navigationTitle(profile == nil ? name : "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.accessibilityIdentifier("spade.profile.done")
                }
            }
        }
        .task { await load() }
        .presentationDragIndicator(.visible)
        .accessibilityIdentifier("spade.profile.sheet")
    }

    /// The face, large, then the name and where it runs.
    @ViewBuilder private var head: some View {
        if let profile {
            Section {
                VStack(spacing: AceDesign.Space.related) {
                    SpadeFaceView(face: profile.face, size: AceDesign.Size.spade)
                    Text(profile.name)
                        .aceFont(AceDesign.TextRole.header)
                        .foregroundStyle(AceDesign.Ink.primary)
                        .accessibilityAddTraits(.isHeader)
                    Text("On \(profile.details.machine)")
                        .aceFont(AceDesign.TextRole.meta)
                        .foregroundStyle(AceDesign.Ink.muted)
                }
                .frame(maxWidth: .infinity)
                .accessibilityElement(children: .combine)
            }
            .listRowBackground(Color.clear)
        }
    }

    /// A part that couldn't be read: the whole profile is read again.
    private func retry() { Task { await load() } }

    private func editor(_ task: String) -> some View {
        SpadeTaskEditor(client: client, agent: agent, task: task) { saved in
            // The saved task shows at once; reads begun before the save are dropped.
            reads.saved(task: saved)
            await load()
        }
    }

    private func load() async {
        let ticket = reads.begin()
        reads.land(await client.spadeProfile(agent), ticket: ticket)
    }
}

/// Details: what the bot is for (its task, which opens to edit), the model and machine it runs
/// with, and its routines with when each runs.
struct SpadeProfileDetails<Editor: View>: View {
    let profile: SpadeProfile
    let retry: () -> Void
    @ViewBuilder let edit: (String) -> Editor

    var body: some View {
        SpadeProfileTask(task: profile.details.task, edit: edit)
        SpadeProfileRunsWith(details: profile.details)
        SpadeProfileRoutines(routines: profile.details.routines, name: profile.name, retry: retry)
    }
}
