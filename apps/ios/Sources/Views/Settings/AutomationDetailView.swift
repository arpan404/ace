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
    @State private var busy = false
    @State private var problem: String?
    @State private var editing = false
    @State private var deleting = false
    @State private var noting = false
    @State private var feedback = 0
    @Environment(\.dismiss) private var dismiss
    @Environment(\.automationLinks) private var links
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var zone: String { TimeZone.current.identifier }
    private var motion: Animation { reduceMotion ? AceTheme.Motion.standardCurve : .smooth }

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
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                Text(row.when).aceFont(AceTheme.Typography.body, relativeTo: .body)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .accessibilityIdentifier("automation.when")
                Text(row.next).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .accessibilityIdentifier("automation.next")
                Text([row.project, row.agent, row.model].compactMap { $0 }.joined(separator: " · "))
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
            }
            .padding(.vertical, AceTheme.Spacing.xs)
            ServiceProblem(message: problem)
        }
        .insetRowBackground()
    }

    private func attentionSection(_ attention: AutomationListRow.Attention) -> some View {
        Section {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                StateLabel(status: StatusDisplay(label: attention.word, token: "failed"))
                    .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                Text(attention.text).aceFont(AceTheme.Typography.body, relativeTo: .body)
                    .foregroundStyle(AceTheme.Colours.foreground)
            }
            .padding(.vertical, AceTheme.Spacing.xs)
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
                Text("Delete").aceFont(InsetStyle.label, relativeTo: .body)
                    .foregroundStyle(AceTheme.StatusText.failed)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .disabled(!canAct)
            .accessibilityIdentifier("automation.delete")
            if !row.enabled {
                Text("Paused. Resume to run it, or to schedule its next run.")
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            if !model.canOperate {
                ViewOnlyNote(message: "View only. To run or change automations from this phone, pair it again with View and act.")
            }
        }
        .insetRowBackground()
    }

    @ViewBuilder private var runsSection: some View {
        Section {
            if !runsLoaded {
                ForEach(0..<2, id: \.self) { _ in AutomationRowPlaceholder() }
            } else if runs.isEmpty {
                Text("No runs yet. Run it now, or wait for it to start.")
                    .aceFont(AceTheme.Typography.body, relativeTo: .body)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .padding(.vertical, AceTheme.Spacing.xs)
            }
            ForEach(runs) { run in
                AutomationRunView(run: run, canRun: canAct && row?.enabled == true,
                                  open: opener(run.threadId),
                                  runAgain: { Task { await runNow(note: nil) } })
            }
            if before != nil {
                textRow(olderLoading ? "Loading older runs…" : "Show older runs", id: "automation.olderRuns") {
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
            Text(title).aceFont(InsetStyle.label, relativeTo: .body)
                .fontWeight(strong ? .semibold : .regular)
                .foregroundStyle(AceTheme.Colours.foreground)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!canAct)
        .accessibilityIdentifier(id)
    }

    // MARK: Reads

    private var source: String { row?.source ?? "person" }

    private func refresh() async {
        await readRow()
        await readRuns()
    }

    /// The row as the list now has it; gone means it was deleted elsewhere.
    private func readRow() async {
        guard let page = try? await model.read(["type": "automations.page", "zone": zone, "fresh": true], as: AutomationPage.self),
              page.ok else { return }
        if let next = ((page.person ?? []) + (page.threads ?? [])).first(where: { $0.id == id }) { row = next }
        else { dismiss() }
    }

    private func readRuns() async {
        do {
            let history = try await model.service(["type": "automations.history", "automationId": id, "source": source, "zone": zone],
                                                  as: AutomationHistory.self)
            guard history.ok else { problem = history.error; return }
            let first = history.runs ?? []
            // Older pages already read stay below the newest page.
            let older = runs.filter { run in !first.contains { $0.id == run.id } && run.startedAt < (first.last?.startedAt ?? .infinity) }
            runs = first + (before == nil ? [] : older)
            if !runsLoaded { before = history.before }
            pollMs = history.pollMs ?? 60_000
        } catch { problem = error.localizedDescription }
        runsLoaded = true
    }

    private func older() async {
        guard let cursor = before else { return }
        olderLoading = true
        defer { olderLoading = false }
        guard let history = try? await model.service(["type": "automations.history", "automationId": id, "source": source,
                                                      "zone": zone, "before": cursor], as: AutomationHistory.self),
              history.ok else { problem = "Couldn't load older runs. Try again."; return }
        runs += (history.runs ?? []).filter { run in !runs.contains { $0.id == run.id } }
        before = history.before
    }

    private func poll() async {
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

    private func runNow(note: String?) async {
        var request: [String: Any] = ["type": "automation.run", "id": id, "variables": [String: String](), "source": source]
        if let note, !note.isEmpty { request["message"] = note }
        // A run that has to wait shows as Queued or Skipped in Runs.
        if await act(request) != nil { await refresh() }
    }

    private func setEnabled(_ enabled: Bool) async {
        var request: [String: Any] = ["type": "automation.setEnabled", "id": id, "enabled": enabled, "source": source]
        if let revision = row?.revision { request["expectedRevision"] = revision }
        if await act(request) != nil { await refresh() }
    }

    private func retry() async {
        var request: [String: Any] = ["type": "automation.retry", "id": id]
        if let revision = row?.revision { request["expectedRevision"] = revision }
        if await act(request) != nil { await refresh() }
    }

    private func duplicate() async {
        guard let row else { return }
        let copy = "auto-\(UUID().uuidString.lowercased())"
        if await write(["type": "automations.duplicate", "automation": row.automation.any, "id": copy]) != nil {
            links?.replace(copy)
        }
    }

    private func remove() async {
        var request: [String: Any] = ["type": "automation.remove", "id": id, "source": source]
        if let revision = row?.revision { request["expectedRevision"] = revision }
        if await act(request) != nil { dismiss() }
    }
}

/// One run: when it started and how it went, what it said, and the way into its thread.
struct AutomationRunView: View {
    let run: AutomationRunRow
    let canRun: Bool
    let open: (() -> Void)?
    let runAgain: () -> Void
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            HStack(spacing: AceTheme.Spacing.xs) {
                if let head = run.head { StateLabel(status: head.status) }
                Text([run.when, run.detail].compactMap { $0 }.joined(separator: " · "))
                    .foregroundStyle(AceTheme.Colours.mutedForeground).monospacedDigit()
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("automation.run.\(run.id)")
            if run.live {
                (Text("Working for ") + Text(Date(timeIntervalSince1970: run.startedAt / 1000), style: .timer))
                    .aceFont(AceTheme.Typography.body, relativeTo: .body)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).monospacedDigit()
            } else if let note = run.note {
                Text(note).aceFont(AceTheme.Typography.body, relativeTo: .body)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            if let body = run.body {
                Text(body).aceFont(AceTheme.Typography.body, relativeTo: .body)
                    .foregroundStyle(run.muted ? AceTheme.Colours.mutedForeground : AceTheme.Colours.foreground)
                    .lineLimit(expanded ? nil : 4)
                    .textSelection(.enabled)
            }
            HStack(spacing: AceTheme.Spacing.lg) {
                if let open {
                    Button("Open thread", action: open).accessibilityIdentifier("automation.run.open.\(run.id)")
                }
                if run.runAgain {
                    Button("Run again", action: runAgain).disabled(!canRun)
                        .accessibilityIdentifier("automation.run.again.\(run.id)")
                }
                if (run.body?.count ?? 0) > 220 {
                    Button(expanded ? "Show less" : "Show all") { withAnimation(.smooth) { expanded.toggle() } }
                }
            }
            .buttonStyle(.borderless)
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            .foregroundStyle(AceTheme.Colours.foreground)
            .frame(minHeight: 44)
        }
        .padding(.top, AceTheme.Spacing.xs)
    }
}

/// "Run now with a note": extra instructions for this run only, added after the saved prompt.
struct AutomationRunNote: View {
    let run: (String) -> Void
    @State private var note = ""
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    var body: some View {
        NavigationStack {
            Form {
                TextField("Anything extra for this run", text: $note, axis: .vertical)
                    .lineLimit(3...10).focused($focused)
                    .accessibilityIdentifier("automation.note")
                    .insetRowBackground()
            }
            .insetGroupedList()
            .navigationTitle("Run with a note").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Run") { run(note.trimmingCharacters(in: .whitespacesAndNewlines)); dismiss() }
                        .disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onAppear { focused = true }
        }
    }
}
