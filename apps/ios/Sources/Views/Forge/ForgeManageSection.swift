import SwiftUI

/// A pull request's management (the web's details and ⋯ menu, for the phone): its milestone,
/// the issues it closes (link one, unlink one linked by hand), its head branch (delete or
/// restore, asked first), and its conversation's lock. Every change names the version shown; a
/// change GitHub hasn't confirmed waits with Reconcile, and nothing else is sent until it is.
struct ForgeManageSection: View {
    let desk: ForgeReviewDesk
    let route: ForgeRoute
    let open: (ForgeRoute) -> Void
    @State private var manage: ForgeManage?
    @State private var message: String?
    @State private var writing = false
    @State private var deleting = false
    @State private var linking = false
    @State private var reverting = false
    /// The edit sheet's starting point: the text and the version it was read at, held while it is open.
    @State private var editing: ForgePullEditTarget?
    private var client: ClientModel { desk.client }
    private var request: [String: Any] { ClientModel.forgeManageRead(project: desk.target.project, number: desk.target.number, repository: route.repository) }

    init(desk: ForgeReviewDesk, route: ForgeRoute, open: @escaping (ForgeRoute) -> Void) {
        self.desk = desk
        self.route = route
        self.open = open
        _manage = State(initialValue: desk.client.kept(ClientModel.forgeManageRead(project: desk.target.project, number: desk.target.number, repository: route.repository), as: ForgeManage.self))
    }

    private var ready: Bool { !writing && client.canOperate && (manage?.unconfirmed.isEmpty ?? false) }

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            if let manage { content(manage) }
        }
        .task(id: client.readGeneration(request)) { await load() }
        .confirmationDialog("Delete \(manage?.branch?.name ?? "the branch")?", isPresented: $deleting, titleVisibility: .visible) {
            Button("Delete branch", role: .destructive) { apply(["kind": "branch.delete"]) }
        } message: { Text("It's deleted on GitHub. Branches and worktrees on your machines stay.") }
        .sheet(isPresented: $linking) {
            ForgeLinkIssueSheet(completer: desk.completer) { number in apply(["kind": "issue.link", "issue": number]) }
        }
        .sheet(item: $editing) { target in
            ForgePullEditSheet(metadata: target.metadata, editable: target.editable) { changes in
                await edit(changes, at: target.version)
            }
        }
        .sheet(isPresented: $reverting) {
            if let draft = manage?.revert, let version = manage?.version {
                ForgeRevertSheet(number: desk.target.number, draft: draft, create: { title, body in await revert(version, title, body) }) { number in
                    open(ForgeRoute(kind: .pull, machineId: route.machineId, project: route.project, number: number, repository: route.repository))
                }
            }
        }
    }

    /// One row per fact or action (ADR 0184): each change of state a row action in the action
    /// colour, the values that change through a menu (milestone, lock) with their value in it, and
    /// the branch with its own action beside it. Revert and Delete branch draw in red.
    @ViewBuilder private func content(_ manage: ForgeManage) -> some View {
        ForgeSection(title: "Manage") {
            if let message {
                ProblemRow(message, id: "forge.manage.problem")
            }
            ForEach(manage.unconfirmed, id: \.self) { change in
                QuietSectionRow {
                    QuietRowText(title: "\(change.label) not confirmed")
                    Button("Reconcile") { write(["kind": "reconcile", "operationId": change.id]) }
                        .buttonStyle(.secondaryAction).controlSize(.small)
                        .disabled(writing || !client.canOperate)
                        .accessibilityIdentifier("forge.manage.reconcile")
                }
            }
            if client.canOperate {
                ForgeLifecycleRows(steps: manage.lifecycle, enabled: ready) { kind in apply(["kind": kind]) }
                if !manage.editable.isEmpty {
                    Button("Edit title, description and labels") {
                        editing = ForgePullEditTarget(version: manage.version, metadata: manage.metadata, editable: manage.editable)
                    }
                    .buttonStyle(.rowAction)
                    .padding(.horizontal, AceDesign.Space.margin)
                    .disabled(!ready)
                    .accessibilityIdentifier("forge.manage.edit")
                }
            }
            milestone(manage)
            ForEach(manage.closingIssues, id: \.number) { issue in issueRow(issue) }
            if manage.canLink, client.canOperate {
                Button { linking = true } label: { AddRow("Link an issue") }
                    .buttonStyle(.plain)
                    .padding(.horizontal, AceDesign.Space.margin)
                    .disabled(!ready)
                    .accessibilityIdentifier("forge.manage.link")
            }
            if let branch = manage.branch { branchRow(branch) }
            if let conversation = manage.conversation { lockRow(conversation, manage.reasons) }
            if manage.revert != nil, client.canOperate {
                Button("Revert", role: .destructive) { reverting = true }
                    .buttonStyle(.rowAction)
                    .padding(.horizontal, AceDesign.Space.margin)
                    .disabled(!ready)
                    .accessibilityIdentifier("forge.manage.revert")
            }
        }
    }

    @ViewBuilder private func milestone(_ manage: ForgeManage) -> some View {
        QuietSectionRow {
            QuietRowText(title: "Milestone")
            if let milestones = manage.milestones, client.canOperate {
                Menu {
                    Picker("Milestone", selection: Binding(get: { manage.milestone?.number }, set: { choose($0, manage) })) {
                        Text("None").tag(Int?.none)
                        ForEach(milestones, id: \.number) { Text($0.title).tag(Optional($0.number)) }
                    }
                } label: { ForgeMenuValue(text: manage.milestone?.title ?? "None") }
                    .disabled(!ready)
                    .accessibilityIdentifier("forge.manage.milestone")
            } else {
                InsetValue(text: manage.milestone?.title ?? "None")
            }
        }
    }

    private func issueRow(_ issue: ForgeManage.Issue) -> some View {
        Button { open(ForgeRoute(kind: .issue, machineId: route.machineId, project: route.project, number: issue.number, repository: route.repository)) } label: {
            QuietSectionRow {
                ForgeIssueGlyph(state: issue.state, size: AceDesign.Size.icon)
                Text(verbatim: "#\(issue.number)").monospacedDigit().meta(AceTheme.Colours.subtleForeground)
                QuietRowText(title: issue.title)
                InsetValue(text: issue.manual ? "Linked" : "Closes")
                RowCaret()
            }
        }
        .buttonStyle(.row)
        .contextMenu {
            if issue.manual, client.canOperate {
                Button("Unlink the issue", ace: .x) {
                    apply(["kind": "issue.unlink", "issue": ["repository": desk.target.repository.json, "number": issue.number]])
                }
            }
        }
    }

    private func branchRow(_ branch: ForgeManage.Branch) -> some View {
        QuietSectionRow {
            QuietRowText(title: branch.name, detail: branch.note ?? (branch.exists ? nil : "Deleted on GitHub"), mono: true,
                         tone: branch.exists ? AceDesign.Ink.primary : AceDesign.Ink.subtle)
            if branch.delete, client.canOperate {
                Button("Delete branch", role: .destructive) { deleting = true }
                    .buttonStyle(.secondaryAction).controlSize(.small)
                    .disabled(!ready).accessibilityIdentifier("forge.manage.delete-branch")
            } else if branch.restore, client.canOperate {
                Button("Restore branch") { apply(["kind": "branch.restore"]) }
                    .buttonStyle(.secondaryAction).controlSize(.small)
                    .disabled(!ready).accessibilityIdentifier("forge.manage.restore-branch")
            }
        }
    }

    private func lockRow(_ conversation: ForgeManage.Conversation, _ reasons: [ForgeManage.Reason]) -> some View {
        QuietSectionRow {
            QuietRowText(title: conversation.locked ? "Conversation locked" : "Conversation", detail: conversation.reason)
            if conversation.unlock, client.canOperate {
                Button("Unlock") { apply(["kind": "unlock"]) }
                    .buttonStyle(.secondaryAction).controlSize(.small)
                    .disabled(!ready).accessibilityIdentifier("forge.manage.unlock")
            } else if conversation.lock, client.canOperate {
                Menu {
                    ForEach(reasons, id: \.value) { reason in Button(reason.label) { apply(["kind": "lock", "reason": reason.value]) } }
                    Button("Without a reason") { apply(["kind": "lock", "reason": NSNull()]) }
                } label: { ForgeMenuValue(text: "Lock") }
                .disabled(!ready)
                .accessibilityIdentifier("forge.manage.lock")
            }
        }
    }

    private func choose(_ number: Int?, _ manage: ForgeManage) {
        guard number != manage.milestone?.number else { return }
        apply(["kind": "edit", "changes": ["milestone": number.map { $0 as Any } ?? NSNull()]])
    }

    /// A change against the version shown.
    private func apply(_ action: [String: Any]) {
        guard let version = manage?.version else { return }
        write(["kind": "apply", "version": version, "action": action])
    }

    private func write(_ operation: [String: Any]) {
        guard !writing else { return }
        writing = true
        Task {
            let outcome = await client.forgeManageWrite(desk.target, operation: operation)
            message = outcome.ok ? nil : outcome.message
            writing = false
        }
    }

    /// The revert, pinned to the version shown; the section reads GitHub again after it.
    private func revert(_ version: String, _ title: String, _ body: String) async -> ForgeWorkOutcome {
        let target = desk.target
        let outcome = await client.forgeWorkWrite(["type": "forge.manage", "project": target.project, "number": target.number,
                                                   "repository": target.repository.json,
                                                   "operation": ["kind": "apply", "version": version, "action": ["kind": "revert", "title": title, "body": body]]])
        await load()
        return outcome
    }

    /// An edit pinned to the version its sheet opened at, so one changed elsewhere since is refused
    /// rather than overwritten. The section reads GitHub again after it either way.
    private func edit(_ changes: [String: Any], at version: String) async -> ForgeReviewOutcome {
        let outcome = await client.forgeManageWrite(desk.target, operation: ["kind": "apply", "version": version,
                                                                             "action": ["kind": "edit", "changes": changes]])
        await load()
        return outcome
    }

    private func load() async {
        do { manage = try await client.forgeManage(project: desk.target.project, number: desk.target.number, repository: route.repository) }
        catch {}
    }
}

/// Link an issue for the pull request to close: `#` search over the repository's issues.
struct ForgeLinkIssueSheet: View {
    let completer: ForgeCompleter
    let link: (Int) -> Void
    @State private var query = ""
    @State private var found: [ForgeCompletions.Item] = []
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(found, id: \.self) { item in
                Button {
                    if let number = Int(item.label.dropFirst()) { link(number); dismiss() }
                } label: {
                    HStack {
                        Text(item.label).monospacedDigit().foregroundStyle(AceTheme.Colours.subtleForeground)
                        Text(item.detail).foregroundStyle(AceTheme.Colours.foreground)
                    }
                }
                .accessibilityIdentifier("forge.link.\(item.label)")
            }
            .listStyle(.plain)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search issues")
            .task(id: query) { await search() }
            .navigationTitle("Link an issue")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    /// The search `#` uses, so both find the same issues.
    private func search() async {
        try? await Task.sleep(for: .milliseconds(180))
        guard !Task.isCancelled else { return }
        let text = "#" + query.trimmingCharacters(in: .whitespaces)
        let items = await completer.suggestions(text: text, start: text.utf16.count, end: text.utf16.count)
        if !Task.isCancelled { found = items }
    }
}
