import SwiftUI

struct AutomationRow: Codable, Identifiable {
    let id: String
    var title: String
    var enabled: Bool
    var workspace: String
    var provider: String
    var prompt: String
    var trigger: ServiceValue
    var worktree: Bool
    var missedRun: String
    var concurrency: Int
    var jitterMs: Int
    var model: String?
    var access: String?
    var payload: [String: Any]? {
        guard let data = try? JSONEncoder().encode(self) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}
struct AutomationReply: Decodable {
    let ok: Bool
    let error: String?
    let automations: [AutomationRow]?
    struct Inbox: Decodable {
        struct Run: Decodable, Identifiable { let id: String; var title: String; let status: String; let result: String? }
        let runs: [Run]
    }
    let inbox: Inbox?
}

/// Daemon automation error codes in people's words, matching the web client.
/// Unknown messages pass through so daemon validation detail is never hidden.
func friendlyAutomationError(_ raw: String?, fallback: String) -> String {
    switch raw {
    case "automation_unavailable":
        return "Automations aren't available on this machine. Restart ace and try again."
    case "Automation service is stopped":
        return "Automations are turned off. Turn on Run automations in Settings › Agents to run one."
    case "disabled_or_missing":
        return "That automation is paused or no longer exists."
    case "forbidden":
        return "This device isn't allowed to change automations."
    default:
        guard let raw, !raw.isEmpty else { return fallback }
        return raw
    }
}

func automationString(_ value: ServiceValue?) -> String? {
    if case .string(let text) = value { return text }
    return nil
}

struct AutomationScheduleFields {
    let kind: String
    let expression: String
    let timezone: String
    let startAt: Double?
}

/// The saved schedule behind a trigger, if it is one. Used to prefill the
/// editor and to keep the existing DTSTART anchor when a schedule is saved.
func automationSchedule(_ trigger: ServiceValue) -> AutomationScheduleFields? {
    guard case .object(let top) = trigger,
        case .string(let kind) = top["kind"], kind == "schedule",
        case .object(let schedule) = top["schedule"],
        case .string(let scheduleKind) = schedule["kind"],
        case .string(let expression) = schedule["expression"],
        case .string(let timezone) = schedule["timezone"] else { return nil }
    let startAt: Double? = {
        if case .number(let instant) = schedule["startAt"] { return instant }
        return nil
    }()
    return AutomationScheduleFields(kind: scheduleKind, expression: expression, timezone: timezone, startAt: startAt)
}

/// One-line trigger summary for the list and the editor's "keep" row.
func describeAutomationTrigger(_ trigger: ServiceValue) -> String {
    guard case .object(let top) = trigger, case .string(let kind) = top["kind"] else {
        return "Configured trigger"
    }
    switch kind {
    case "manual":
        return "Only when run by hand"
    case "schedule":
        guard case .object(let schedule) = top["schedule"] else { return "On a schedule" }
        let expression = automationString(schedule["expression"]) ?? ""
        let timezone = automationString(schedule["timezone"]) ?? ""
        let scheduleKind = automationString(schedule["kind"]) ?? ""
        if expression.isEmpty {
            return timezone.isEmpty ? "On a schedule" : "On a schedule (\(timezone))"
        }
        if scheduleKind == "cron" {
            return timezone.isEmpty ? "Cron \(expression)" : "Cron \(expression) (\(timezone))"
        }
        return timezone.isEmpty ? expression : "\(expression) (\(timezone))"
    case "github":
        let repository = automationString(top["repository"]) ?? "a repository"
        let event = automationString(top["event"]) ?? "an event"
        let label = automationString(top["label"])
        let when: String
        switch event {
        case "pr_changed": when = "a pull request opens or changes"
        case "ci_failed": when = "CI fails"
        case "review_comment": when = "a review comment arrives"
        case "issue_labelled": when = "an issue is labelled"
        default: when = event
        }
        if let label, !label.isEmpty {
            return "When \(when) (\(label)) in \(repository)"
        }
        return "When \(when) in \(repository)"
    case "file":
        if case .array(let paths) = top["paths"] {
            let names = paths.compactMap { automationString($0) }.filter { !$0.isEmpty }
            if names.isEmpty { return "When files change" }
            return "When \(names.joined(separator: ", ")) change"
        }
        return "When files change"
    default:
        return "Configured trigger"
    }
}
struct AutomationsView: View {
    let model: ClientModel
    @State private var rows: [AutomationRow] = []
    @State private var runs: [AutomationReply.Inbox.Run] = []
    @State private var editing: AutomationRow?
    @State private var removing: AutomationRow?
    @State private var loading = true
    @State private var busy = false
    @State private var problem: String?
    @State private var unavailable = false
    var body: some View {
        List {
            Group {
                if loading { HStack { Spacer(); ProgressView().accessibilityLabel("Reading automations"); Spacer() } }
                ServiceProblem(message: problem)
                if !model.canOperate {
                    ViewOnlyNote(message: "View only. To change automations from this phone, pair it again with View and act.")
                }
                if !loading && rows.isEmpty && problem == nil { ContentUnavailableView("No automations", systemImage: "clock.arrow.circlepath") }
            }
            .listRowBackground(Color.clear)
            ForEach(rows) { row in
                Section {
                    Toggle("Enabled", isOn: Binding(get: { row.enabled }, set: { enabled in
                        var changed = row; changed.enabled = enabled
                        if let automation = changed.payload { perform(["type": "automation.put", "automation": automation]) }
                    }))
                    Text(describeAutomationTrigger(row.trigger))
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                    if !row.enabled {
                        Text("Paused. Resume to schedule runs.")
                            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                    Text(row.prompt).lineLimit(4)
                    LabeledContent("Provider", value: row.provider.capitalized)
                    Text(row.workspace).aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                    Button("Edit", systemImage: "pencil") { editing = row }
                    Button("Delete", role: .destructive) { removing = row }
                    Button("Run now", systemImage: "play") {
                        perform(["type": "automation.run", "id": row.id, "variables": [String: String]()])
                    }
                    .disabled(!row.enabled)
                } header: {
                    InsetHeader(row.title.isEmpty ? "Untitled automation" : row.title)
                }
                .insetRowBackground()
                .disabled(!model.canOperate || busy)
            }
            if !runs.isEmpty {
                Section {
                    ForEach(runs) { run in
                        VStack(alignment: .leading) {
                            LabeledContent(run.title, value: run.status.capitalized)
                            if let result = run.result { Text(result).lineLimit(3).foregroundStyle(AceTheme.Colours.mutedForeground) }
                        }
                    }
                } header: { InsetHeader("Recent runs") }
                .insetRowBackground()
            }
        }
        .insetGroupedList()
        .navigationTitle("Automations").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("New automation", systemImage: "plus") {
                    editing = AutomationRow(id: UUID().uuidString, title: "", enabled: true, workspace: "", provider: model.providers?.providers.first?.provider ?? "codex", prompt: "", trigger: .object(["kind": .string("manual")]), worktree: false, missedRun: "skip", concurrency: 1, jitterMs: 0, model: nil, access: nil)
                }.disabled(!model.canOperate || unavailable)
            }
        }
        .sheet(item: $editing) { row in
            NavigationStack { AutomationEditor(model: model, initial: row) { Task { await read() } } }
        }
        .confirmationDialog("Delete automation?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { row in
            Button("Delete \(row.title.isEmpty ? "automation" : row.title)", role: .destructive) {
                removing = nil
                perform(["type": "automation.remove", "id": row.id])
            }
        } message: { _ in
            Text("Its run history stays on this machine.")
        }
        .readWhenConnected(model) { await read() }.refreshable { await read() }
    }
    private func read() async {
        defer { loading = false }
        do {
            let list = try await model.service(["type": "automation.list"], as: AutomationReply.self)
            guard list.ok else {
                if list.error == "automation_unavailable" { unavailable = true }
                throw ServiceFailure(message: friendlyAutomationError(list.error, fallback: "Couldn't read automations"))
            }
            unavailable = false
            rows = list.automations ?? []; problem = nil
            do {
                let history = try await model.service(["type": "automation.inbox", "limit": 20], as: AutomationReply.self)
                runs = history.ok ? (history.inbox?.runs ?? []) : []
            } catch {
                runs = []
            }
        } catch { problem = error.localizedDescription }
    }
    private func perform(_ payload: [String: Any]) {
        busy = true
        Task {
            defer { busy = false }
            do {
                let reply = try await model.service(payload, as: AutomationReply.self)
                guard reply.ok else { throw ServiceFailure(message: friendlyAutomationError(reply.error, fallback: "Couldn't save or run this automation. Check its project and agent, then try again.")) }
                await read()
            } catch { problem = error.localizedDescription }
        }
    }
}
