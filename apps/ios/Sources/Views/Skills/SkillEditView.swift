import SwiftUI

/// Editing a skill: what it does, when it runs and its instructions. The name stays. A save the
/// machine refuses because the skill changed there says so, and Reload brings the new text in.
/// What was typed stays on screen until the machine confirms the save; a save that didn't hear
/// back can be sent again without applying twice (`bridge/skill-library.ts`).
struct SkillEditView: View {
    let model: ClientModel
    let workspaceId: String?
    let saved: (SkillPage) -> Void
    @State private var page: SkillPage
    @State private var description: String
    @State private var manual: Bool
    @State private var bodyDirty = false
    @State private var session = 0
    @State private var saving = false
    @State private var conflict = false
    @State private var problem: String?
    @State private var discarding = false
    @State private var handle = SourceHandle()
    @Environment(\.dismiss) private var dismiss

    init(model: ClientModel, page: SkillPage, workspaceId: String?, saved: @escaping (SkillPage) -> Void) {
        self.model = model
        self.workspaceId = workspaceId
        self.saved = saved
        _page = State(initialValue: page)
        _description = State(initialValue: page.description)
        _manual = State(initialValue: page.manual)
    }

    private var dirty: Bool { bodyDirty || description != page.description || manual != page.manual }
    private var at: [String: Any] { workspaceId.map { ["workspaceId": $0] } ?? [:] }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                QuietField("Description") {
                    TextField("What it does and when an agent should use it", text: $description, axis: .vertical)
                        .lineLimit(1...4).accessibilityIdentifier("skill.edit.description")
                }
                SkillRunsPicker(choices: page.runsChoices, manual: $manual)
                if conflict || problem != nil {
                    if conflict {
                        QuietProblem(message: "This skill changed on the machine since you opened it.",
                                     id: "skill.edit.conflict",
                                     retry: { Task { await reload() } }, retryLabel: "Reload")
                            .transition(.opacity)
                    } else if let problem {
                        QuietProblem(message: problem, id: "skill.edit.problem").transition(.opacity)
                    }
                }
                QuietHeading("Instructions").padding(.horizontal, AceDesign.Space.margin)
                SourceTextView(document: SourceDocument(key: "\(page.hash)|\(session)", text: page.body, language: nil, marks: [:]),
                               wrap: true, editable: !saving, line: nil, handle: handle, dirty: { bodyDirty = $0 })
                    .accessibilityIdentifier("skill.edit.body")
                    .ignoresSafeArea(.container, edges: .bottom)
            }
            .padding(.top, AceDesign.Space.related)
            .background(AceDesign.Surface.background)
            .animation(.default, value: conflict)
            .animation(.default, value: problem)
            .navigationTitle("Edit \(page.title)").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { if dirty { discarding = true } else { dismiss() } }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView().accessibilityLabel("Saving") }
                    else {
                        Button("Save") { Task { await save() } }
                            .disabled(!dirty || description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("skill.edit.save")
                    }
                }
            }
            .confirmationDialog("Discard your changes?", isPresented: $discarding, titleVisibility: .visible) {
                Button("Discard changes", role: .destructive) { dismiss() }
            }
        }
        .interactiveDismissDisabled(dirty || saving)
    }

    private func save() async {
        saving = true; problem = nil; conflict = false
        defer { saving = false }
        do {
            _ = try await model.skills(["op": "edit", "id": page.id, "expectedHash": page.hash, "description": description,
                                        "body": handle.text, "manual": manual].merging(at) { $1 }, as: SkillSaved.self)
            let fresh = try await model.skills(["op": "skill", "id": page.id].merging(at) { $1 }, as: SkillPage.self)
            saved(fresh)
        } catch let failure as SkillFailure {
            if failure.code == "conflict" { conflict = true } else { problem = failure.message }
        } catch { problem = error.localizedDescription }
    }
    private func reload() async {
        do {
            let fresh = try await model.skills(["op": "skill", "id": page.id].merging(at) { $1 }, as: SkillPage.self)
            page = fresh; description = fresh.description; manual = fresh.manual
            bodyDirty = false; session += 1; conflict = false
        } catch { problem = error.localizedDescription }
    }
}

/// Runs: "When it fits" or "Only when picked", on one glass capsule.
struct SkillRunsPicker: View {
    let choices: [SkillRunsChoice]
    @Binding var manual: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            QuietHeading("Runs")
            GlassChoice(items: choices.map { GlassChoiceItem(id: $0.manual ? "manual" : "auto", label: $0.label) },
                        selection: manual ? "manual" : "auto", idPrefix: "skill.runs") { manual = $0 == "manual" }
        }
        .padding(.horizontal, AceDesign.Space.margin)
        .sensoryFeedback(.selection, trigger: manual)
    }
}
