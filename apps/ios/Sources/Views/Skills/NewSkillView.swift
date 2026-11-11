import SwiftUI

/// Writing a new skill: its name, what it does, its instructions, where it is saved, which
/// agents see it and when it runs. The name is checked as it is typed, against the same rules
/// and list the web's form uses (`bridge/skill-library.ts`); the machine has the last word. The
/// fields and its choices are on the page itself, as the design language's sheets are: quiet
/// headings, hairlines, actions as words; a read that failed says so where its rows would be.
struct NewSkillView: View {
    /// Content geometry: the placeholder starts where the editor's text does, past its line numbers.
    private static let pastGutter: CGFloat = 52
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
    /// The name check's last read didn't answer: its own sentence, with Retry.
    @State private var checkProblem: String?
    /// The agents and runs didn't arrive: their own sentence, with Retry, in place of the rows.
    @State private var choicesProblem: String?
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
            ScrollView {
                VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                    if let problem { QuietProblem(message: problem, id: "skill.new.create.problem") }
                    QuietField("Name") {
                        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                            TextField("release-notes", text: $name)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .aceMonospace(AceTheme.Typography.code, relativeTo: .body)
                                .accessibilityIdentifier("skill.new.name")
                            nameLine
                        }
                    }
                    QuietField("Description") {
                        TextField("What it does and when an agent should use it", text: $description, axis: .vertical)
                            .lineLimit(1...4).accessibilityIdentifier("skill.new.description")
                    }
                    QuietField("Instructions") {
                        SourceTextView(document: SourceDocument(key: "new", text: "", language: nil, marks: [:]),
                                       wrap: true, editable: !creating, line: nil, handle: handle, dirty: { bodyDirty = $0 })
                            .frame(height: AceDesign.Size.editorHeight)
                            .overlay(alignment: .topLeading) {
                                if !bodyDirty {
                                    Text("Steps, rules and examples the agent follows")
                                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                                        .foregroundStyle(AceTheme.Colours.subtleForeground)
                                        .padding(.leading, Self.pastGutter).padding(.top, AceTheme.Spacing.sm)
                                        .allowsHitTesting(false).transition(.opacity)
                                }
                            }
                            .accessibilityIdentifier("skill.new.body")
                    }
                    if let project { scopeChoice(project) }
                    agentsSection
                    if !runs.isEmpty { runsChoice }
                }
                .padding(.top, AceDesign.Space.related).padding(.bottom, AceDesign.Space.group)
            }
            .background(AceDesign.Surface.background)
            .animation(.default, value: agents)
            .animation(.default, value: problem)
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

    /// What the name check says: a refusal in the failed colour, or the path the skill will take.
    @ViewBuilder private var nameLine: some View {
        if let checkProblem {
            HStack(spacing: AceDesign.Space.related) {
                Text(checkProblem).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.StatusText.failed)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("skill.new.nameReadProblem")
                Button("Retry") { Task { await checkName() } }
                    .buttonStyle(.textAction(.prominent))
            }
        } else if let problem = check?.problem, !trimmed.isEmpty {
            Text(problem).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                .foregroundStyle(AceTheme.StatusText.failed)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("skill.new.nameProblem")
        } else {
            Text(check?.path ?? " ").aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.faintForeground)
                .lineLimit(1).truncationMode(.middle)
        }
    }

    private func scopeChoice(_ project: NativeProject) -> some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            QuietHeading("Save in")
            GlassChoice(items: [GlassChoiceItem(id: "personal", label: "Personal"),
                                GlassChoiceItem(id: "project", label: "\(project.name) project")],
                        selection: scope, idPrefix: "skill.new.scope") { scope = $0 }
                .disabled(creating)
        }
        .padding(.horizontal, AceDesign.Space.margin)
    }

    /// Which agents see it: a switch each, or the read's own sentence while they haven't arrived.
    private var agentsSection: some View {
        QuietSection("Agents") {
            if let choicesProblem {
                QuietProblem(message: choicesProblem, id: "skill.new.choices.problem") { Task { await readChoices() } }
            } else if agents.isEmpty {
                SkeletonRows(count: 3, label: "Reading agents")
            } else {
                SkillAgentToggles(agents: $agents)
            }
        }
    }

    private var runsChoice: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            QuietHeading("Runs")
            GlassChoice(items: runs.map { GlassChoiceItem(id: $0.manual ? "manual" : "auto", label: $0.label) },
                        selection: manual ? "manual" : "auto", idPrefix: "skill.new.runs") { manual = $0 == "manual" }
                .disabled(creating)
        }
        .padding(.horizontal, AceDesign.Space.margin)
    }

    private func readChoices() async {
        do {
            let choices = try await model.skills(["op": "draft"].merging(at) { $1 }, as: SkillDraftChoices.self)
            agents = choices.agents; runs = choices.runs
            choicesProblem = nil
        } catch { if !Task.isCancelled { choicesProblem = error.localizedDescription } }
    }
    private func checkName() async {
        let key = "\(scope)|\(trimmed)"
        // Typing settles first, so each keystroke doesn't cost a round trip.
        try? await Task.sleep(for: .milliseconds(150))
        guard !Task.isCancelled else { return }
        checkProblem = nil
        do {
            let result = try await model.skills(["op": "check", "name": trimmed, "scope": scope].merging(at) { $1 }, as: SkillNameCheck.self)
            guard !Task.isCancelled else { return }
            check = result; checked = key; checkProblem = nil
        } catch {
            // An empty name needs no check: the failure names a check that never mattered.
            if !Task.isCancelled, !trimmed.isEmpty { checkProblem = error.localizedDescription }
        }
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
