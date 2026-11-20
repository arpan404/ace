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
    @State private var profile: SpadeProfile?
    @State private var problem: String?

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
                    case .details: SpadeProfileDetails(profile: profile, edit: editor)
                    case .library: SpadeProfileLibrary(library: profile.library, name: profile.name)
                    case .computer: SpadeProfileComputer(computer: profile.computer)
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

    private func editor(_ task: String) -> some View {
        SpadeTaskEditor(client: client, agent: agent, task: task) { await load() }
    }

    private func load() async {
        let answer = await client.spadeProfile(agent)
        if let fresh = answer.profile {
            profile = fresh
            problem = nil
        } else if profile == nil {
            problem = answer.problem ?? "Couldn't read the profile."
        }
    }
}

/// The task on its own page: the bot's instructions in the person's words, saved with Save.
struct SpadeTaskEditor: View {
    let client: ClientModel
    let agent: String
    let task: String
    let saved: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var saving = false
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
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { save() }
                    .disabled(!changed || saving)
                    .accessibilityIdentifier("spade.task.save")
            }
        }
        .onAppear {
            text = task
            focused = true
        }
    }

    private func save() {
        saving = true
        Task {
            let outcome = await client.spadeTask(agent, task: text)
            saving = false
            problem = outcome.problem
            guard outcome.ok else { return }
            await saved()
            dismiss()
        }
    }
}
