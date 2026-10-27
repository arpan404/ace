import SwiftUI

/// A skill from the agents' own folders: who loads it, where it lives, when it runs, how often
/// it was used and its instructions. The person's own skills can be edited, re-linked to other
/// agents and deleted from here.
struct SkillPageView: View {
    let model: ClientModel
    let route: SkillRoute
    let workspaceId: String?
    let project: String?
    @State private var page: SkillPage?
    @State private var problem: String?
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
            if let page {
                if !page.description.isEmpty {
                    Text(page.description).aceFont(AceTheme.Typography.body, relativeTo: .body)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 0, leading: AceTheme.Spacing.xs, bottom: 0, trailing: AceTheme.Spacing.xs))
                }
                details(page)
                Section {
                    MarkdownView(text: page.instructions.isEmpty ? "_No instructions yet._" : page.instructions)
                        .padding(.vertical, AceTheme.Spacing.sm)
                } header: {
                    HStack {
                        InsetHeader("Instructions")
                        Spacer()
                        if page.editable, model.canOperate {
                            Button("Edit") { editing = true }
                                .aceFont(InsetStyle.header, relativeTo: .subheadline).textCase(nil)
                                .frame(minHeight: AceTheme.Dimensions.touchTarget)
                                .accessibilityIdentifier("skill.edit")
                        }
                    }
                }
                .insetRowBackground()
                if page.editable, model.canOperate {
                    Section {
                        Button("Delete skill", role: .destructive) { deleting = true }
                            .disabled(busy).accessibilityIdentifier("skill.delete")
                    }
                    .insetRowBackground()
                }
            } else if problem == nil {
                SkillPagePlaceholder()
            }
            if let problem {
                Section {
                    ServiceProblem(message: problem)
                    Button("Try again") { Task { await read() } }
                }
                .insetRowBackground()
            }
        }
        .insetGroupedList()
        .animation(.smooth, value: page)
        .animation(.smooth, value: notice)
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

    @ViewBuilder private func details(_ page: SkillPage) -> some View {
        Section {
            InsetRow(systemImage: nil, title: "Agents", subtitle: page.agentsText) {
                if page.editable, model.canOperate {
                    Button("Change") { choosingAgents = true }.buttonStyle(.borderless).disabled(busy)
                        .accessibilityIdentifier("skill.agents")
                }
            }
            if let notice {
                Text(notice).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).transition(.opacity)
            }
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text("Saved in").aceFont(InsetStyle.label, relativeTo: .body)
                Text(page.savedIn).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                if let path = page.path {
                    Text(path).aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.faintForeground).textSelection(.enabled)
                }
            }
            .padding(.vertical, AceTheme.Spacing.xs)
            SkillOpenOnComputer(model: model, target: page.open)
            runsRow(page)
            if let hint = page.argumentHint {
                InsetRow(systemImage: nil, title: "Arguments", subtitle: hint) { EmptyView() }
            }
            InsetRow(systemImage: nil, title: "Used", subtitle: usedText(page)) { EmptyView() }
        } header: { InsetHeader("Details") }
        .insetRowBackground()
    }

    @ViewBuilder private func runsRow(_ page: SkillPage) -> some View {
        InsetRow(systemImage: nil, title: "Runs", subtitle: page.runs) {
            if page.editable, model.canOperate {
                Picker("Runs", selection: Binding(get: { page.manual }, set: { manual in Task { await setRuns(manual) } })) {
                    ForEach(page.runsChoices, id: \.manual) { Text($0.label).tag($0.manual) }
                }
                .labelsHidden().pickerStyle(.menu).tint(AceTheme.Colours.mutedForeground).disabled(busy)
                .accessibilityIdentifier("skill.runs")
            }
        }
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
        do {
            _ = try await model.skills(["op": "edit", "id": page.id, "expectedHash": page.hash, "description": page.description,
                                        "body": page.body, "manual": manual].merging(at) { $1 }, as: SkillSaved.self)
            changed += 1
            await read()
        } catch { problem = error.localizedDescription }
    }
    private func setAgents(_ agents: [String]) async {
        guard let page else { return }
        busy = true; defer { busy = false }
        do {
            let reply = try await model.skills(["op": "agents", "id": page.id, "agents": agents].merging(at) { $1 }, as: SkillAgentsSaved.self)
            changed += 1; notice = reply.note
            await read()
        } catch { problem = error.localizedDescription }
    }
    private func delete() async {
        guard let page else { return }
        busy = true; defer { busy = false }
        do {
            _ = try await model.skills(["op": "delete", "id": page.id, "expectedHash": page.hash, "retry": deleteUncertain].merging(at) { $1 }, as: ServiceValue.self)
            deleted += 1
            dismiss()
        } catch let failure as SkillFailure {
            deleteUncertain = failure.uncertain
            problem = failure.message
        } catch { problem = error.localizedDescription }
    }
}

/// The page's shape while it reads.
private struct SkillPagePlaceholder: View {
    var body: some View {
        Section {
            ForEach(["Agents", "Saved in", "Runs", "Used"], id: \.self) { title in
                InsetRow(systemImage: nil, title: title, subtitle: "Claude Code and Codex") { EmptyView() }
            }
        } header: { InsetHeader("Details") }
        .insetRowBackground()
        .redacted(reason: .placeholder)
        .transition(.opacity)
    }
}

/// Open on computer: the skill's SKILL.md on the machine running ace.
///
/// TODO(host.open): draws nothing until `host.open` from branch
/// `ace/ios-gaps-projects-machines-notes` is merged. Then the bridge's `hostOpenTarget`
/// (`bridge/skill-host-open.ts`) returns a target, and this body becomes
/// `if let target { OpenOnHostMenu(model: model, target: HostOpenTarget(workspaceId: target.workspaceId, path: target.path, line: nil)) { Text("Open on computer") } }`.
struct SkillOpenOnComputer: View {
    let model: ClientModel
    let target: SkillHostTarget?
    var body: some View { EmptyView() }
}
