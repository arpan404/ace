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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxl) {
                    if let work { content(work) } else { WorkSkeleton() }
                }
                .padding(.vertical, AceTheme.Spacing.lg)
                .animation(reduceMotion ? .easeInOut(duration: AceTheme.Motion.fast) : .smooth, value: work)
            }
            .background(AceTheme.Colours.background)
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
        if work.problem != nil || work.locked { problems(work).transition(.opacity) }
        WorkSection(title: "Checkout") {
            WorkRow(label: work.machine.isEmpty ? "This machine" : work.machine, value: work.project)
            if !work.path.isEmpty { WorkRow(label: work.path, mono: true, quiet: true) }
            if work.state == "error" {
                WorkRow(label: "Couldn't read the checkout", value: work.error, failed: true)
            } else if work.state == "none" || work.chat {
                WorkRow(label: work.chat ? "A chat's folder" : "Not a git checkout", quiet: true)
            } else if work.state == "loading" {
                WorkRow(label: "Reading the checkout", quiet: true).redacted(reason: .placeholder)
            } else {
                place(work, mode: "local", label: "Local checkout", reason: work.switchReason)
                place(work, mode: "worktree", label: "Worktree", reason: work.worktreeReason)
            }
        }
        if !work.chat, work.state == "ready" {
            WorkSection(title: "Branch") {
                Button { model.sheet(["kind": "work.branches"]); picking = true } label: {
                    WorkRow(label: work.branch, value: work.baseBranch.isEmpty || work.baseBranch == work.branch ? "" : "into \(work.baseBranch)", mono: true, disclosure: true)
                }
                .buttonStyle(.plain)
                .disabled(!model.canOperate)
                .accessibilityLabel("Branch \(work.branch), switch branch")
                .accessibilityIdentifier("work.branch")
                if !work.note.isEmpty { WorkRow(label: work.note, quiet: true) }
            }
            pullRequests(work)
        }
    }

    /// Local or a worktree: the current one is marked; the other moves there, unless it can't now.
    private func place(_ work: WorkSummary, mode: String, label: String, reason: String?) -> some View {
        let current = work.mode == mode
        return HStack(spacing: AceTheme.Spacing.sm) {
            AceIcon(mode == "worktree" ? .gitFork : .folder, size: 16, relativeTo: .body).foregroundStyle(AceTheme.Colours.subtleForeground)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                Text(label).foregroundStyle(AceTheme.Colours.foreground)
                if !current, let reason { Text(reason).aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground) }
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            if current { Text("Current").foregroundStyle(AceTheme.Colours.mutedForeground) }
            else if model.canOperate, reason == nil {
                WorkWordButton(label: mode == "worktree" ? "Move to worktree" : "Move to local", identifier: "work.move.\(mode)") {
                    runner.send(["kind": "move", "mode": mode], model: model)
                }
                .disabled(!canAct)
            }
        }
        .aceFont(AceTheme.Typography.label, relativeTo: .body)
        .padding(.horizontal, AceTheme.Spacing.lg).frame(minHeight: AceTheme.Dimensions.touchTarget)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("work.place.\(mode)")
    }

    private func pullRequests(_ work: WorkSummary) -> some View {
        WorkSection(title: "Pull requests") {
            ForEach(work.prs) { pr in
                HStack(spacing: AceTheme.Spacing.sm) {
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
                        WorkWordButton(label: "Unlink", destructive: true, identifier: "work.unlink.\(pr.number)") { unlinking = pr }
                            .disabled(!canAct)
                    }
                }
                .padding(.horizontal, AceTheme.Spacing.lg)
            }
            if work.morePrs > 0 { WorkRow(label: "\(work.morePrs) more linked on your computer", quiet: true) }
            if work.prs.isEmpty { WorkRow(label: "None linked", quiet: true) }
            if model.canOperate {
                WorkWordButton(label: "Link a PR", identifier: "work.link") { reference = ""; linking = true }
                    .disabled(!canAct).padding(.horizontal, AceTheme.Spacing.sm)
            }
        }
    }

    /// What stops the checkout first: the loud part of the sheet.
    @ViewBuilder private func problems(_ work: WorkSummary) -> some View {
        WorkSection(title: "Needs attention") {
            if let problem = work.problem {
                WorkProblemRows(problem: problem, canAct: canAct && model.canOperate) { action in
                    if action.id == "clear-move" { clearingMove = true }
                    else { runner.send(["kind": "problem", "id": action.id], model: model) }
                }
            }
            if work.locked {
                WorkRow(label: "Git is locked", value: "An earlier ace daemon left a Git lock", failed: true)
                if model.canOperate {
                    WorkWordButton(label: "Clear stale lock", destructive: true, identifier: "work.clearLock") { confirmingLock = true }
                        .disabled(!canAct).padding(.horizontal, AceTheme.Spacing.sm)
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
                return (result.message, result.ok ? AceTheme.Colours.foreground : AceTheme.StatusText.failed)
            }
            if running { return ("Working on the checkout…", AceTheme.Colours.mutedForeground) }
            if !model.canOperate, work != nil { return ("View only: this phone can't change the checkout.", AceTheme.Colours.mutedForeground) }
            return nil
        }()
        if let (message, colour) = text {
            HStack(spacing: AceTheme.Spacing.sm) {
                if running { ProgressView().controlSize(.small) }
                Text(message).foregroundStyle(colour).lineLimit(3)
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .footnote)
            .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.md)
            .aceGlass(in: AceShape.capsule)
            .padding(.bottom, AceTheme.Spacing.sm)
            .frame(maxWidth: .infinity)
            .transition(.opacity)
            .accessibilityIdentifier(result != nil ? "work.outcome" : running ? "work.running" : "work.readOnly")
        }
    }
}
