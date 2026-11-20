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

/// The task on its own page: the bot's instructions in the person's words, saved with Save.
/// While the write is out the field and Save wait and the page stays (`SpadeTaskSave`); once it
/// went they stay locked until the page closes on the reloaded profile.
struct SpadeTaskEditor: View {
    let client: ClientModel
    let agent: String
    let task: String
    /// The task as Spade stored it.
    let saved: (String) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var save = SpadeTaskSave()
    @State private var problem: String?
    @FocusState private var focused: Bool

    private var changed: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines) != task.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        Form {
            Section {
                TextEditor(text: $text)
                    .aceFont(AceDesign.TextRole.message)
                    .frame(minHeight: AceDesign.Size.rowThread * 3)
                    .focused($focused)
                    .disabled(save.locked)
                    .accessibilityIdentifier("spade.task.field")
            } footer: {
                if let problem {
                    Text(problem).foregroundStyle(AceTheme.StatusText.failed)
                } else {
                    Text("What this bot is for, in your words.")
                }
            }
        }
        .navigationTitle("Task")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(save.locked)
        .interactiveDismissDisabled(save.locked)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if save.locked { ProgressView() } else {
                    Button("Save") { submit() }
                        .disabled(!changed)
                        .accessibilityIdentifier("spade.task.save")
                }
            }
        }
        .onAppear {
            text = task
            focused = true
        }
    }

    private func submit() {
        guard let words = save.begin(text, task: task) else { return }
        problem = nil
        focused = false
        Task {
            let outcome = await client.spadeTask(agent, task: words)
            guard outcome.ok else {
                save.refused()
                problem = outcome.problem
                return
            }
            await saved(outcome.task ?? words)
            dismiss()
        }
    }
}
