import SwiftUI

/// Writing a new skill: its name, what it does, its instructions, where it is saved, which
/// agents see it and when it runs. The name is checked as it is typed, against the same rules
/// and list the web's form uses (`bridge/skill-library.ts`); the machine has the last word.
struct NewSkillView: View {
    let model: ClientModel
    let project: NativeProject?
    let created: (SkillRoute) -> Void
    @State private var name = ""
    @State private var description = ""
    @State private var scope = "personal"
    @State private var manual = false
    @State private var agents: [SkillAgentChoice] = []
    @State private var runs: [SkillRunsChoice] = []
    @State private var check: SkillNameCheck?
    @State private var checked = ""
    @State private var bodyDirty = false
    @State private var creating = false
    /// The last create didn't hear back: sending it again says so (see `bridge/skill-library.ts`).
    @State private var uncertain = false
    @State private var problem: String?
    @State private var discarding = false
    @State private var handle = SourceHandle()
    @Environment(\.dismiss) private var dismiss

    private var trimmed: String { name.trimmingCharacters(in: .whitespaces) }
    private var dirty: Bool { !name.isEmpty || !description.isEmpty || bodyDirty }
    private var ready: Bool {
        !trimmed.isEmpty && checked == "\(scope)|\(trimmed)" && check?.problem == nil
            && !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && agents.contains(where: \.on) && !creating
    }
    private var at: [String: Any] { project.map { ["workspaceId": $0.id] } ?? [:] }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("release-notes", text: $name)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .aceMonospace(AceTheme.Typography.code, relativeTo: .body)
                        .accessibilityIdentifier("skill.new.name")
                } header: { InsetHeader("Name") } footer: {
                    if let problem = check?.problem, !trimmed.isEmpty {
                        Text(problem).foregroundStyle(AceTheme.StatusText.failed).accessibilityIdentifier("skill.new.nameProblem")
                    } else {
                        Text(check?.path ?? " ").aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.Colours.faintForeground)
                    }
                }
                Section {
                    TextField("What it does and when an agent should use it", text: $description, axis: .vertical)
                        .lineLimit(1...4).accessibilityIdentifier("skill.new.description")
                } header: { InsetHeader("Description") }
                Section {
                    SourceTextView(document: SourceDocument(key: "new", text: "", colours: [], runs: [], marks: [:]),
                                   wrap: true, editable: !creating, line: nil, handle: handle, dirty: { bodyDirty = $0 })
                        .frame(height: 220)
                        .clipShape(AceShape.group)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                        .accessibilityIdentifier("skill.new.body")
                } header: { InsetHeader("Instructions") }
                if let project {
                    Section {
                        GlassChoice(items: [GlassChoiceItem(id: "personal", label: "Personal"), GlassChoiceItem(id: "project", label: "\(project.name) project")],
                                    selection: scope, idPrefix: "skill.new.scope") { scope = $0 }
                            .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                    } header: { InsetHeader("Save in") }
                }
                Section {
                    if agents.isEmpty {
                        ForEach(0..<5, id: \.self) { _ in Text("Claude Code").redacted(reason: .placeholder) }
                    }
                    SkillAgentToggles(agents: $agents)
                } header: { InsetHeader("Agents") }
                if !runs.isEmpty {
                    Section {
                        GlassChoice(items: runs.map { GlassChoiceItem(id: $0.manual ? "manual" : "auto", label: $0.label) },
                                    selection: manual ? "manual" : "auto", idPrefix: "skill.new.runs") { manual = $0 == "manual" }
                            .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                    } header: { InsetHeader("Runs") } footer: {
                        if let problem { ServiceProblem(message: problem) }
                    }
                }
            }
            .insetRowBackground()
            .insetGroupedList()
            .animation(.smooth, value: agents)
            .animation(.smooth, value: problem)
            .sensoryFeedback(.selection, trigger: agents)
            .sensoryFeedback(.selection, trigger: scope)
            .navigationTitle("New skill").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { if dirty { discarding = true } else { dismiss() } }.disabled(creating)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if creating { ProgressView().accessibilityLabel("Creating") }
                    else { Button("Create") { Task { await create() } }.disabled(!ready).accessibilityIdentifier("skill.new.create") }
                }
            }
            .confirmationDialog("Discard this skill?", isPresented: $discarding, titleVisibility: .visible) {
                Button("Discard skill", role: .destructive) { dismiss() }
            }
            .task { await readChoices() }
            .task(id: "\(scope)|\(trimmed)") { await checkName() }
        }
        .interactiveDismissDisabled(dirty || creating)
    }

    private func readChoices() async {
        guard let choices = try? await model.skills(["op": "draft"].merging(at) { $1 }, as: SkillDraftChoices.self) else { return }
        agents = choices.agents; runs = choices.runs
    }
    private func checkName() async {
        let key = "\(scope)|\(trimmed)"
        // Typing settles first, so each keystroke doesn't cost a round trip.
        try? await Task.sleep(for: .milliseconds(150))
        guard !Task.isCancelled,
              let result = try? await model.skills(["op": "check", "name": trimmed, "scope": scope].merging(at) { $1 }, as: SkillNameCheck.self),
              !Task.isCancelled else { return }
        check = result; checked = key
    }
    private func create() async {
        creating = true; problem = nil
        defer { creating = false }
        do {
            let made = try await model.skills(["op": "create", "name": trimmed, "description": description, "body": handle.text,
                                               "scope": scope, "agents": agents.filter(\.on).map(\.id), "manual": manual,
                                               "retry": uncertain].merging(at) { $1 }, as: SkillCreated.self)
            uncertain = false
            created(SkillRoute(id: made.id, title: trimmed))
        } catch let failure as SkillFailure {
            uncertain = failure.uncertain
            problem = "Couldn't create the skill. \(failure.message)"
        } catch { problem = error.localizedDescription }
    }
}
