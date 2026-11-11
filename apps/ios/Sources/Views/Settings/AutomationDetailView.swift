import SwiftUI

/// One automation: when it runs and when it next starts, what needs the person, its actions as
/// visible words (Run now, Pause or Resume, Edit, Duplicate, Delete), then its runs, newest
/// first, each linked to the thread it ran in. Words come from the bridge; this draws and asks.
struct AutomationDetailView: View {
    let model: ClientModel
    let id: String
    @State private var row: AutomationListRow?
    @State private var runs: [AutomationRunRow] = []
    @State private var before: Int?
    @State private var pollMs = 60_000
    @State private var runsLoaded = false
    @State private var olderLoading = false
    @State private var olderProblem: String?
    @State private var busy = false
    private enum FailedAction { case refresh, run(String?), enabled(Bool), retry, duplicate, remove }
    @State private var failedAction = FailedAction.refresh
    @State private var problem: String?
    @State private var historyProblem: String?
    @State private var editing = false
    @State private var deleting = false
    @State private var noting = false
    @State private var feedback = 0
    /// The copy Duplicate is making, kept until it lands so a retry never makes a second.
    @State private var copyId: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.automationLinks) private var links
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var zone: String { TimeZone.current.identifier }
    private var motion: Animation { .default }

    /// Opens on the row the list last read, so its words show in the first frame.
    init(model: ClientModel, id: String) {
        self.model = model
        self.id = id
        let kept = model.kept(["type": "automations.page", "zone": TimeZone.current.identifier], as: AutomationPage.self)
        _row = State(initialValue: ((kept?.person ?? []) + (kept?.threads ?? [])).first { $0.id == id })
    }

    private var own: Bool { row?.source != "thread" }
    private var canAct: Bool { model.canOperate && !busy }

    var body: some View {
        List {
            if let row {
                summary(row)
                if let attention = row.attention { attentionSection(attention) }
                actions(row)
            }
            if row == nil && problem == nil { Section { SkeletonRows(count: 2, label: "Loading automation") }.insetRowBackground() }
            if let problem {
                Section {
                    ServiceProblem(message: problem)
                    Button("Retry") { Task { await retryFailure() } }.buttonStyle(.textAction()).disabled(busy)
                }.insetRowBackground()
            }
            if let historyProblem {
                Section {
                    ServiceProblem(message: historyProblem)
                    Button("Retry") { Task { await readRuns() } }.buttonStyle(.textAction())
                }.insetRowBackground()
            }
            runsSection
        }
        .insetGroupedList()
        .animation(motion, value: runs)
        .animation(motion, value: row)
        .navigationTitle(row?.title ?? "Automation").navigationBarTitleDisplayMode(.inline)
        .sensoryFeedback(.success, trigger: feedback)
        .sheet(isPresented: $editing) {
            if let row {
                NavigationStack {
                    AutomationEditor(model: model, editing: row) { _ in Task { await refresh() } }
                }
            }
        }
        .sheet(isPresented: $noting) {
            AutomationRunNote { note in Task { await runNow(note: note) } }
                .presentationDetents([.medium])
        }
        .confirmationDialog("Delete this automation?", isPresented: $deleting, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await remove() } }
        } message: {
            Text("Its runs and their threads stay on this machine.")
        }
        .task { await poll() }
        .refreshable { await refresh() }
    }

    // MARK: Sections

    private func summary(_ row: AutomationListRow) -> some View {
        Section {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                Text(row.when).font(AceDesign.Typeface.title)
                    .foregroundStyle(AceDesign.Ink.primary)
                    .accessibilityIdentifier("automation.when")
                Text(row.next).font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceDesign.Ink.muted)
                    .accessibilityIdentifier("automation.next")
                Text([row.project, row.agent, row.model].compactMap { $0 }.joined(separator: " · "))
                    .font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceDesign.Ink.muted).lineLimit(1)
            }
            .padding(.vertical, AceDesign.Space.tight)
        }
        .insetRowBackground()
    }

    private func attentionSection(_ attention: AutomationListRow.Attention) -> some View {
        Section {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                StateLabel(status: StatusDisplay(label: attention.word, token: "failed"))
                    .font(AceDesign.Typeface.body)
                Text(attention.text).font(AceDesign.Typeface.title)
                    .foregroundStyle(AceDesign.Ink.primary)
            }
            .padding(.vertical, AceDesign.Space.tight)
            if attention.retry && own {
                textRow("Retry", id: "automation.retry") { Task { await retry() } }
            }
        }
        .insetRowBackground()
        .transition(.opacity)
    }

    private func actions(_ row: AutomationListRow) -> some View {
        Section {
            textRow("Run now", id: "automation.runNow", strong: true) { Task { await runNow(note: nil) } }
                .disabled(!row.enabled)
            textRow("Run now with a note", id: "automation.runNote") { noting = true }
                .disabled(!row.enabled)
            textRow(row.enabled ? "Pause" : "Resume", id: "automation.toggle") { Task { await setEnabled(!row.enabled) } }
            if own {
                textRow("Edit", id: "automation.edit") { editing = true }
                textRow("Duplicate", id: "automation.duplicate") { Task { await duplicate() } }
            }
            Button(role: .destructive) { deleting = true } label: {
                Text("Delete").font(AceDesign.Typeface.body)
                    .foregroundStyle(AceTheme.StatusText.failed)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .disabled(!canAct)
            .accessibilityIdentifier("automation.delete")
            if !row.enabled {
                Text("Paused. Resume to run it, or to schedule its next run.")
                    .font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceDesign.Ink.muted)
            }
            if !model.canOperate {
                ViewOnlyNote(message: "View only. To run or change automations from this phone, pair it again with View and act.")
            }
        }
        .insetRowBackground()
    }

    @ViewBuilder private var runsSection: some View {
        Section {
            if !runsLoaded && problem == nil && historyProblem == nil {
                ForEach(0..<2, id: \.self) { _ in AutomationRowPlaceholder() }
            } else if runsLoaded && runs.isEmpty && problem == nil && historyProblem == nil {
                Text("No runs yet. Run it now, or wait for it to start.")
                    .font(AceDesign.Typeface.title)
                    .foregroundStyle(AceDesign.Ink.muted)
                    .padding(.vertical, AceDesign.Space.tight)
            }
            ForEach(runs) { run in
                AutomationRunView(run: run, canRun: canAct && row?.enabled == true,
                                  open: opener(run.threadId),
                                  runAgain: { Task { await runNow(note: nil) } })
            }
            ServiceProblem(message: olderProblem)
            if before != nil {
                textRow(olderLoading ? "Loading older runs…" : olderProblem == nil ? "Show older runs" : "Retry", id: "automation.olderRuns") {
                    Task { await older() }
                }
                .disabled(olderLoading)
            }
        } header: { InsetHeader("Runs") }
        .insetRowBackground()
    }

    /// "Open thread" for a run that has one.
    private func opener(_ threadId: String?) -> (() -> Void)? {
        guard let threadId, let links else { return nil }
        return { links.thread(threadId) }
    }

    private func textRow(_ title: String, id: String, strong: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(AceDesign.Typeface.body)
                .fontWeight(strong ? .semibold : .regular)
                .foregroundStyle(AceDesign.Ink.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!canAct)
        .accessibilityIdentifier(id)
    }

    // MARK: Reads

    private var source: String { row?.source ?? "person" }

    private func refresh() async {
        problem = nil; failedAction = .refresh
        await readRow()
        await readRuns()
    }

    /// The row as the list now has it; gone means it was deleted elsewhere.
    private func readRow() async {
        do {
            let page = try await model.read(["type": "automations.page", "zone": zone, "fresh": true], as: AutomationPage.self)
            guard page.ok else { throw ServiceFailure(message: page.error ?? "Couldn't load this automation.") }
            if let next = ((page.person ?? []) + (page.threads ?? [])).first(where: { $0.id == id }) { row = next }
            else { dismiss() }
        } catch { if !Task.isCancelled { failedAction = .refresh; problem = error.localizedDescription } }
    }

    private func readRuns() async {
        do {
            let history = try await model.service(["type": "automations.history", "automationId": id, "source": source, "zone": zone],
                                                  as: AutomationHistory.self)
            guard history.ok else { throw ServiceFailure(message: history.error ?? "Couldn't load runs.") }
            let first = history.runs ?? []
            // Older pages already read stay below the newest page.
            runs = refreshedAutomationHistory(first, keeping: runs, startedAt: { $0.startedAt })
            if !runsLoaded { before = history.before }
            runsLoaded = true
            pollMs = history.pollMs ?? 60_000
            historyProblem = nil
        } catch { if !Task.isCancelled { historyProblem = error.localizedDescription } }
    }

    private func older() async {
        guard let cursor = before else { return }
        olderLoading = true
        defer { olderLoading = false }
        guard let history = try? await model.service(["type": "automations.history", "automationId": id, "source": source,
                                                      "zone": zone, "before": cursor], as: AutomationHistory.self),
              history.ok else { olderProblem = "Couldn't load older runs."; return }
        olderProblem = nil
        runs += (history.runs ?? []).filter { run in !runs.contains { $0.id == run.id } }
        before = history.before
    }

    private func poll() async {
        // One the list hasn't read yet (a copy just made) reads its own row first.
        if row == nil { await readRow() }
        await readRuns()
        while !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(pollMs))
            if Task.isCancelled { return }
            await readRuns()
            if runs.contains(where: { $0.status == "succeeded" || $0.status == "failed" }) { await readRow() }
        }
    }

    // MARK: Writes

    private func write(_ payload: [String: Any], success: String? = nil) async -> AutomationWrite? {
        busy = true
        defer { busy = false }
        do {
            let reply = try await model.service(payload, as: AutomationWrite.self)
            guard reply.ok else { problem = reply.error ?? "Couldn't change this automation. Try again."; return nil }
            problem = nil
            feedback += 1
            return reply
        } catch { problem = error.localizedDescription; return nil }
    }

    /// One of the daemon writes the bridge words for the person (`automations.write`).
    private func act(_ request: [String: Any]) async -> AutomationWrite? {
        await write(["type": "automations.write", "request": request])
    }

    private func retryFailure() async {
        switch failedAction {
        case .refresh: await refresh()
        case .run(let note): await runNow(note: note)
        case .enabled(let enabled): await setEnabled(enabled)
        case .retry: await retry()
        case .duplicate: await duplicate()
        case .remove: await remove()
        }
    }

    private func runNow(note: String?) async {
        failedAction = .run(note)
        var request: [String: Any] = ["type": "automation.run", "id": id, "variables": [String: String](), "source": source]
        if let note, !note.isEmpty { request["message"] = note }
        // A run that has to wait shows as Queued or Skipped in Runs.
        if await act(request) != nil { await refresh() }
    }

    private func setEnabled(_ enabled: Bool) async {
        failedAction = .enabled(enabled)
        var request: [String: Any] = ["type": "automation.setEnabled", "id": id, "enabled": enabled, "source": source]
        if let revision = row?.revision { request["expectedRevision"] = revision }
        if await act(request) != nil { await refresh() }
    }

    private func retry() async {
        failedAction = .retry
        var request: [String: Any] = ["type": "automation.retry", "id": id]
        if let revision = row?.revision { request["expectedRevision"] = revision }
        if await act(request) != nil { await refresh() }
    }

    private func duplicate() async {
        failedAction = .duplicate
        guard let row else { return }
        // One id per Duplicate: pressed again after a lost reply, it sends the same copy, which
        // the bridge counts as made instead of making a second.
        let copy = copyId ?? "auto-\(UUID().uuidString.lowercased())"
        copyId = copy
        if await write(["type": "automations.duplicate", "automation": row.automation.any, "id": copy]) != nil {
            copyId = nil
            links?.replace(copy)
        }
    }

    private func remove() async {
        failedAction = .remove
        var request: [String: Any] = ["type": "automation.remove", "id": id, "source": source]
        if let revision = row?.revision { request["expectedRevision"] = revision }
        if await act(request) != nil {
            // The list offers Undo; it makes the automation again from this definition.
            if let row { links?.undo.deleted = .init(title: row.title, automation: row.automation) }
            dismiss()
        }
    }
}
