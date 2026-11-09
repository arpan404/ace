import SwiftUI

/// The thread's Work: where its checkout lives and what can move it, as the web's Work card has
/// it. Checkout (machine, project, folder; local or a worktree, and moving between them), Branch
/// (switch, from a searchable list), Pull requests (each linked one, Link a PR, Unlink as a red
/// word asked first) and what stops the checkout, with its ways out. The bridge follows the
/// thread only while this is shown; every rule is `@ace/ui-core`'s. A view-only phone sees it all
/// without the actions.
struct WorkSheet: View {
    @Bindable var model: ClientModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openPullRequest) private var openPull
    @State private var runner = WorkRunner()
    @State private var picking = false
    @State private var linking = false
    @State private var reference = ""
    @State private var unlinking: WorkSummary.PullRequest?
    @State private var clearingMove = false
    @State private var confirmingLock = false
    private var work: WorkSummary? { model.sheets.work }
    private var canAct: Bool { model.canOperate && work?.busy != true && !runner.running(in: model) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                    if let work { content(work) } else { WorkSkeleton() }
                }
                .padding(.top, AceDesign.Space.related).padding(.bottom, AceDesign.Space.group)
                .animation(.default, value: work)
            }
            .background(AceDesign.Surface.background)
            .refreshable { model.sheet(["kind": "work.refresh"]) }
            .navigationTitle("Work")
            .navigationBarTitleDisplayMode(.inline)
            .escapeCloses { dismiss() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close").accessibilityIdentifier("work.close")
                }
            }
            .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) { outcome }
            .navigationDestination(isPresented: $picking) { WorkBranchPicker(model: model, runner: runner) }
        }
        .tint(AceTheme.Colours.foreground)
        .workQuestions(runner: runner, model: model, confirmingLock: $confirmingLock)
        .alert("Link a pull request", isPresented: $linking) {
            TextField("URL or #number", text: $reference).textInputAutocapitalization(.never).autocorrectionDisabled()
                .keyboardType(.URL).accessibilityIdentifier("work.link.field")
            Button("Cancel", role: .cancel) {}
            Button("Link") { runner.send(["kind": "link", "reference": reference], model: model) }
                .disabled(reference.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("work.link.submit")
        }
        .confirmationDialog("Unlink #\(unlinking?.number ?? 0)?", isPresented: Binding(get: { unlinking != nil }, set: { if !$0 { unlinking = nil } }),
                            titleVisibility: .visible, presenting: unlinking) { pr in
            Button("Unlink", role: .destructive) {
                runner.send(["kind": "unlink", "number": pr.number, "repo": ["owner": pr.owner, "name": pr.name]], model: model)
            }.accessibilityIdentifier("work.unlink.confirm")
            Button("Cancel", role: .cancel) {}
        } message: { _ in Text("The pull request stays on GitHub. Its link is removed from this thread.") }
        .confirmationDialog("Clear the failed move?", isPresented: $clearingMove, titleVisibility: .visible) {
            Button("Clear move", role: .destructive) { runner.send(["kind": "problem", "id": "clear-move"], model: model) }
                .accessibilityIdentifier("work.clearMove.confirm")
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("ace releases the checkout this move reserved, once Git reports it free. The thread stays where it is; nothing in either checkout is deleted.")
        }
        .onAppear { model.sheet(["kind": "work", "open": true]) }
        .onDisappear { model.sheet(["kind": "work", "open": false]) }
    }

    @ViewBuilder private func content(_ work: WorkSummary) -> some View {
        WorkHeader(work: work)
        if work.problem != nil || work.locked { problems(work).transition(.opacity) }
        if work.state == "error" {
            WorkStatus(label: "Couldn't read the checkout", detail: work.error) { EmptyView() }
        }
        if !work.chat, work.state == "ready" {
            QuietSection("Branch") {
                Button { model.sheet(["kind": "work.branches"]); picking = true } label: {
                    QuietSectionRow {
                        QuietRowText(title: work.branch, detail: work.baseBranch.isEmpty || work.baseBranch == work.branch ? nil : "Into \(work.baseBranch)", mono: true)
                        RowCaret()
                    }
                }
                .buttonStyle(.row)
                .disabled(!model.canOperate)
                .accessibilityLabel("Branch \(work.branch), switch branch")
                .accessibilityIdentifier("work.branch")
                if !work.note.isEmpty {
                    QuietSectionRow { QuietRowText(title: work.note, tone: AceDesign.Ink.muted) }
                }
            }
            QuietSection("Checkout") {
                place(work, mode: "local", label: "Local checkout", reason: work.switchReason)
                place(work, mode: "worktree", label: "Worktree", reason: work.worktreeReason)
            }
            pullRequests(work)
        }
    }

    /// Local or a worktree: the current one is marked; the other moves there, unless it can't now.
    private func place(_ work: WorkSummary, mode: String, label: String, reason: String?) -> some View {
        WorkPlaceRow(label: label, current: work.mode == mode, reason: reason, mode: mode, canMove: model.canOperate, enabled: canAct) {
            runner.send(["kind": "move", "mode": mode], model: model)
        }
    }

    private func pullRequests(_ work: WorkSummary) -> some View {
        QuietSection("Pull requests") {
            ForEach(work.prs) { pr in
                HStack(spacing: AceDesign.Space.related) {
                    if let openPull, let project = work.workspaceId, !project.isEmpty {
                        // The phone's own pull request page, pushed on the thread's stack.
                        Button {
                            dismiss()
                            openPull(project, pr.number, pr.repository)
                        } label: { WorkPullLine(pr: pr) }
                        .buttonStyle(.plain)
                        .accessibilityHint("Opens the pull request")
                    } else if let url = URL(string: pr.url) {
                        Link(destination: url) { WorkPullLine(pr: pr) }.buttonStyle(.plain)
                            .accessibilityHint("Opens on GitHub")
                    } else { WorkPullLine(pr: pr) }
                    if model.canOperate {
                        Button("Unlink") { unlinking = pr }
                            .buttonStyle(.textAction())
                            .disabled(!canAct)
                            .accessibilityLabel("Unlink #\(pr.number)")
                            .accessibilityIdentifier("work.unlink.\(pr.number)")
                    }
                }
                .padding(.horizontal, AceDesign.Space.margin).padding(.vertical, AceDesign.Space.tight)
            }
            if work.morePrs > 0 {
                QuietSectionRow { QuietRowText(title: "\(work.morePrs) more linked on your computer", tone: AceDesign.Ink.muted) }
            }
            if work.prs.isEmpty, !model.canOperate {
                QuietSectionRow { QuietRowText(title: "None linked", tone: AceDesign.Ink.muted) }
            }
            if model.canOperate {
                QuietSectionRow {
                    Button(work.prs.isEmpty ? "Link a pull request" : "Link another") { reference = ""; linking = true }
                        .buttonStyle(.textAction(.prominent))
                        .disabled(!canAct)
                        .accessibilityIdentifier("work.link")
                    Spacer(minLength: AceTheme.Spacing.none)
                }
            }
        }
    }

    /// What stops the checkout comes first, as one sentence with its ways out.
    @ViewBuilder private func problems(_ work: WorkSummary) -> some View {
        if let problem = work.problem {
            WorkProblemRows(problem: problem, canAct: canAct && model.canOperate) { action in
                if action.id == "clear-move" { clearingMove = true }
                else { runner.send(["kind": "problem", "id": action.id], model: model) }
            }
        }
        if work.locked {
            WorkStatus(label: "Git is locked", detail: "An earlier ace daemon left a Git lock. Nothing can change the checkout until it's cleared.") {
                if model.canOperate {
                    Button("Clear stale lock") { confirmingLock = true }
                        .buttonStyle(.textAction(.destructive))
                        .disabled(!canAct)
                        .accessibilityIdentifier("work.clearLock")
                }
            }
        }
    }

    /// The write in flight, its outcome, or why this phone can't act.
    @ViewBuilder private var outcome: some View {
        let result = runner.result(in: model)
        let running = runner.running(in: model) || work?.busy == true
        let text: (String, Color)? = {
            if let result, result.ask == nil, !result.message.isEmpty {
                return (result.message, result.ok ? AceDesign.Ink.primary : AceTheme.StatusText.failed)
            }
            if running { return ("Working on the checkout", AceDesign.Ink.muted) }
            if !model.canOperate, work != nil { return ("View only: this phone can't change the checkout.", AceDesign.Ink.muted) }
            return nil
        }()
        if let (message, colour) = text {
            HStack(spacing: AceTheme.Spacing.sm) {
                if running { WorkingMark(label: "Working on the checkout") }
                Text(message).foregroundStyle(colour).lineLimit(3)
            }
            .aceFont(AceDesign.TextRole.action, relativeTo: .footnote)
            .padding(.horizontal, AceDesign.Space.margin).padding(.vertical, AceDesign.Space.row)
            .aceGlass(in: AceDesign.Shape.control)
            .padding(.horizontal, AceDesign.Space.margin).padding(.bottom, AceDesign.Space.related)
            .frame(maxWidth: .infinity)
            .transition(.opacity)
            .accessibilityIdentifier(result != nil ? "work.outcome" : running ? "work.running" : "work.readOnly")
        }
    }
}
