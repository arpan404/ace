import SwiftUI

/// A skill from the agents' own folders: who loads it, where it lives, when it runs, how often
/// it was used and its instructions. The person's own skills can be edited, re-linked to other
/// agents and deleted from here, and one installed from a repository updated.
struct SkillPageView: View {
    let model: ClientModel
    let route: SkillRoute
    let workspaceId: String?
    let project: String?
    @State private var page: SkillPage?
    /// The read's last failure: its sentence and Retry sit where the page would be.
    @State private var problem: String?
    /// A change to Runs or Agents failed. Its own sentence, beside the Details rows it changed and
    /// with no Retry: reading again would not repeat the change, so the person repeats it.
    @State private var actionProblem: String?
    /// Delete failed: the same, beside the Delete row.
    @State private var deleteProblem: String?
    @State private var notice: String?
    @State private var editing = false
    @State private var choosingAgents = false
    @State private var deleting = false
    @State private var busy = false
    /// The last delete didn't hear back: the next one says so, and a gone skill counts as deleted.
    @State private var deleteUncertain = false
    @State private var changed = 0
    @State private var deleted = 0
    @Environment(\.dismiss) private var dismiss

    private var at: [String: Any] { workspaceId.map { ["workspaceId": $0] } ?? [:] }

    var body: some View {
        List {
            if let problem {
                Section { ProblemRow(problem, id: "skill.read.problem") { Task { await read() } } }
            }
            if let page {
                header(page)
                if let actionProblem {
                    Section { ProblemRow(actionProblem, id: "skill.action.problem") }
                }
                details(page)
                instructions(page)
                if page.editable, model.canOperate {
                    if let deleteProblem {
                        Section { ProblemRow(deleteProblem, id: "skill.delete.problem") }
                    }
                    Section {
                        Button("Delete skill", role: .destructive) { deleting = true }
                            .buttonStyle(.rowAction)
                            .disabled(busy)
                            .accessibilityIdentifier("skill.delete")
                    }
                    .insetRowBackground()
                }
            } else if problem == nil {
                Section { SkeletonRows(count: 4, label: "Reading the skill").listRowInsets(EdgeInsets()) }
                    .listRowBackground(Color.clear)
            }
        }
        .insetGroupedList()
        .animation(.default, value: page)
        .animation(.default, value: notice)
        .sensoryFeedback(.success, trigger: changed)
        .sensoryFeedback(.success, trigger: deleted)
        .navigationTitle(page?.title ?? route.title).navigationBarTitleDisplayMode(.inline)
        .readWhenConnected(model) { await read() }
        .refreshable { await read() }
        .sheet(isPresented: $editing) {
            if let page {
                SkillEditView(model: model, page: page, workspaceId: workspaceId) { saved in
                    editing = false; changed += 1; self.page = saved
                }
            }
        }
        .sheet(isPresented: $choosingAgents) {
            if let page {
                SkillAgentsSheet(page: page) { agents in
                    choosingAgents = false
                    Task { await setAgents(agents) }
                }
            }
        }
        .confirmationDialog("Delete \(page?.title ?? route.title)?", isPresented: $deleting, titleVisibility: .visible) {
            Button("Delete skill", role: .destructive) { Task { await delete() } }
        } message: { Text(page?.deleteMessage ?? "") }
    }

    @ViewBuilder private func header(_ page: SkillPage) -> some View {
        if !page.description.isEmpty {
            Section {
                Text(page.description).aceFont(AceDesign.TextRole.rowTitle)
                    .foregroundStyle(AceDesign.Ink.primary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.vertical, AceDesign.Space.tight)
            }
            .insetRowBackground()
        }
    }

    private func details(_ page: SkillPage) -> some View {
        Section {
            HStack(spacing: AceDesign.Space.related) {
                QuietRowText(title: "Agents", detail: page.agentsText)
                if page.editable, model.canOperate {
                    Button("Change") { choosingAgents = true }
                        .buttonStyle(.secondaryAction).controlSize(.small)
                        .disabled(busy)
                        .accessibilityIdentifier("skill.agents")
                }
            }
            if let notice {
                Text(notice).aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(AceDesign.Ink.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            }
            savedIn(page)
            if let source = page.source {
                SkillSourceRow(model: model, page: page, source: source, workspaceId: workspaceId) { applied in
                    changed += 1; notice = applied.notice
                    Task { await read() }
                }
            }
            if page.open != nil, model.canOperate {
                SkillOpenOnComputer(model: model, skillId: page.id, workspaceId: workspaceId)
            }
            runsRow(page)
            if let hint = page.argumentHint { QuietRowText(title: "Arguments", detail: hint) }
            QuietRowText(title: "Used", detail: usedText(page))
        } header: { InsetHeader("Details") }
        .insetRowBackground()
    }

    /// Where it lives: its place in words, then the folder in mono.
    private func savedIn(_ page: SkillPage) -> some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            QuietRowText(title: "Saved in", detail: page.savedIn)
            if let path = page.path {
                Text(verbatim: path).aceMonospace(AceDesign.TextRole.code)
                    .foregroundStyle(AceDesign.Ink.subtle).textSelection(.enabled)
            }
        }
    }

    @ViewBuilder private func runsRow(_ page: SkillPage) -> some View {
        if page.editable, model.canOperate {
            Picker(selection: Binding(get: { page.manual }, set: { manual in Task { await setRuns(manual) } })) {
                ForEach(page.runsChoices, id: \.manual) { Text($0.label).tag($0.manual) }
            } label: { QuietRowText(title: "Runs", detail: page.runs) }
            .pickerStyle(.menu).disabled(busy)
            .accessibilityIdentifier("skill.runs")
        } else {
            QuietRowText(title: "Runs", detail: page.runs)
        }
    }

    /// Its instructions, with Edit in the heading's place at the end of the list.
    private func instructions(_ page: SkillPage) -> some View {
        Section {
            AceMarkdown(text: page.instructions.isEmpty ? "_No instructions yet._" : page.instructions)
                .padding(.vertical, AceDesign.Space.tight)
            if page.editable, model.canOperate {
                Button("Edit instructions") { editing = true }
                    .buttonStyle(.rowAction)
                    .accessibilityIdentifier("skill.edit")
            }
        } header: { InsetHeader("Instructions") }
        .insetRowBackground()
    }

    private func usedText(_ page: SkillPage) -> String {
        guard let last = page.last else { return page.used }
        return "\(page.used) · last in \(last.title), \(last.ago)"
    }

    private func read() async {
        do {
            page = try await model.skills(["op": "skill", "id": route.id, "project": project ?? ""].merging(at) { $1 }, as: SkillPage.self)
            problem = nil
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
    private func setRuns(_ manual: Bool) async {
        guard let page, !busy else { return }
        busy = true; defer { busy = false }
        actionProblem = nil
        do {
            _ = try await model.skills(["op": "edit", "id": page.id, "expectedHash": page.hash, "description": page.description,
                                        "body": page.body, "manual": manual].merging(at) { $1 }, as: SkillSaved.self)
            changed += 1
            await read()
        } catch { actionProblem = error.localizedDescription }
    }
    private func setAgents(_ agents: [String]) async {
        guard let page else { return }
        busy = true; defer { busy = false }
        actionProblem = nil
        do {
            let reply = try await model.skills(["op": "agents", "id": page.id, "agents": agents].merging(at) { $1 }, as: SkillAgentsSaved.self)
            changed += 1; notice = reply.note
            await read()
        } catch { actionProblem = error.localizedDescription }
    }
    private func delete() async {
        guard let page else { return }
        busy = true; defer { busy = false }
        deleteProblem = nil
        do {
            _ = try await model.skills(["op": "delete", "id": page.id, "expectedHash": page.hash, "retry": deleteUncertain].merging(at) { $1 }, as: ServiceValue.self)
            deleted += 1
            dismiss()
        } catch let failure as SkillFailure {
            deleteUncertain = failure.uncertain
            deleteProblem = failure.message
        } catch { deleteProblem = error.localizedDescription }
    }
}
