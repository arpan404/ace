import SwiftUI

/// One automation's settings in a sheet: its task, project and agent, and trigger, then Save.
struct AutomationEditor: View {
    let model: ClientModel
    let saved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var row: AutomationRow
    @State private var trigger = "keep"
    @State private var cron = "0 9 * * 1-5"
    @State private var timezone = TimeZone.current.identifier
    @State private var saving = false
    @State private var problem: String?
    init(model: ClientModel, initial: AutomationRow, saved: @escaping () -> Void) {
        self.model = model; self.saved = saved; _row = State(initialValue: initial)
        // Prefill the cron fields from the saved schedule so opening a cron
        // automation and saving as cron never overwrites it with the defaults.
        if let schedule = automationSchedule(initial.trigger), schedule.kind == "cron" {
            _cron = State(initialValue: schedule.expression)
            _timezone = State(initialValue: schedule.timezone)
        }
    }
    var body: some View {
        List {
            Section {
                TextField("Title", text: $row.title).aceFont(SettingsStyle.label, relativeTo: .body)
                TextField("Task instructions", text: $row.prompt, axis: .vertical).lineLimit(4...12)
                    .aceFont(SettingsStyle.label, relativeTo: .body)
            } header: { SettingsHeader("Task") }
            .settingsRow()
            projectSection
            triggerSection
            saveSection
        }
        .settingsList()
        .navigationTitle("Automation").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        .task { model.composeAction(["kind": "projects"]) }
    }
    private var projectSection: some View {
        Section {
            if !model.compose.projects.isEmpty {
                SettingsRow(title: "Project") {
                    Picker("Project", selection: $row.workspace) {
                        Text(row.workspace.isEmpty ? "Choose a project" : row.workspace).tag(row.workspace)
                        ForEach(model.compose.projects.filter { $0.path != row.workspace }) { project in Text(project.name).tag(project.path) }
                    }
                    .labelsHidden().pickerStyle(.menu).tint(AceTheme.Colours.mutedForeground)
                }
            } else {
                TextField("Project folder on your machine", text: $row.workspace).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .aceFont(SettingsStyle.label, relativeTo: .body)
            }
            SettingsRow(title: "Coding agent") {
                Picker("Coding agent", selection: $row.provider) {
                    ForEach(Array(Set((model.providers?.providers.map(\.provider) ?? []) + [row.provider])).sorted(), id: \.self) { Text($0.capitalized).tag($0) }
                }
                .labelsHidden().pickerStyle(.menu).tint(AceTheme.Colours.mutedForeground)
            }
            TextField("Model (optional)", text: Binding(get: { row.model ?? "" }, set: { row.model = $0.isEmpty ? nil : $0 })).textInputAutocapitalization(.never).autocorrectionDisabled()
                .aceFont(SettingsStyle.label, relativeTo: .body)
            Toggle(isOn: $row.worktree) { SettingsRow(title: "Use a worktree") { EmptyView() } }
        } header: { SettingsHeader("Project and agent") }
        .settingsRow()
    }
    private var triggerSection: some View {
        Section {
            SettingsRow(title: "Run", description: trigger == "keep" ? describeAutomationTrigger(row.trigger) : nil) {
                Picker("Run", selection: $trigger) {
                    Text("Keep configured trigger").tag("keep")
                    Text("Manually").tag("manual")
                    Text("Cron schedule").tag("cron")
                }
                .labelsHidden().pickerStyle(.menu).tint(AceTheme.Colours.mutedForeground)
            }
            if trigger == "cron" {
                TextField("Cron expression", text: $cron).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .aceFont(SettingsStyle.label, relativeTo: .body)
                TextField("Time zone", text: $timezone).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .aceFont(SettingsStyle.label, relativeTo: .body)
                SettingsRow(title: "Missed runs") {
                    Picker("Missed runs", selection: $row.missedRun) { Text("Skip").tag("skip"); Text("Run once").tag("run_once") }
                        .labelsHidden().pickerStyle(.menu).tint(AceTheme.Colours.mutedForeground)
                }
                if let cronProblem {
                    Text(cronProblem)
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.StatusText.failed)
                } else if let timezoneProblem {
                    Text(timezoneProblem)
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.StatusText.failed)
                }
            }
            Toggle(isOn: $row.enabled) { SettingsRow(title: "Enabled") { EmptyView() } }
            Stepper(value: $row.concurrency, in: 1...32) { SettingsRow("Concurrent runs", value: "\(row.concurrency)") }
        } header: {
            SettingsHeader("Trigger", note: "GitHub and file triggers stay as configured. Pick Cron schedule to replace the trigger.")
        }
        .settingsRow()
    }
    /// Why Save can't go yet, then Save itself.
    private var saveSection: some View {
        Section {
            if !model.canOperate {
                ViewOnlyNote(message: "View only. To save automations from this phone, pair it again with View and act.")
            }
            if let validationProblem, model.canOperate {
                Text(validationProblem)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            ServiceProblem(message: problem)
            Button { Task { await save() } } label: { SettingsRow(title: "Save automation") { EmptyView() } }
                .buttonStyle(.plain)
                .disabled(cannotSave)
                .opacity(cannotSave ? AceTheme.Opacity.disabled(scheme) : 1)
        }
        .settingsRow()
    }
    private var cannotSave: Bool { saving || validationProblem != nil || !model.canOperate }
    private var cronProblem: String? {
        let expression = cron.trimmingCharacters(in: .whitespacesAndNewlines)
        if expression.isEmpty { return "Enter a schedule." }
        if expression.split(whereSeparator: { $0.isWhitespace }).count != 5 {
            return "Cron needs five fields: minute hour day month weekday."
        }
        return nil
    }
    private var timezoneProblem: String? {
        let zone = timezone.trimmingCharacters(in: .whitespacesAndNewlines)
        if zone.isEmpty { return "Choose a time zone." }
        if TimeZone(identifier: zone) == nil { return "Choose a time zone from the list." }
        return nil
    }
    /// What still blocks a save, in the order a person would fix it. Nil when it can go.
    private var validationProblem: String? {
        if row.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Give the automation a name."
        }
        if row.title.count > 256 { return "Keep the name to 256 characters." }
        if row.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Say what the agent should do."
        }
        if row.workspace.isEmpty { return "Choose a project." }
        if row.provider.isEmpty { return "Choose a coding agent." }
        if let model = row.model, model.count > 256 { return "Keep the model to 256 characters." }
        if trigger == "cron" {
            return cronProblem ?? timezoneProblem
        }
        return nil
    }
    private func save() async {
        if let validationProblem { problem = validationProblem; return }
        saving = true
        defer { saving = false }
        var next = row
        if trigger == "manual" { next.trigger = .object(["kind": .string("manual")]) }
        if trigger == "cron" {
            // Keep the existing DTSTART anchor when editing a schedule so the
            // recurrence does not restart; new schedules start now, minute-aligned.
            let anchor = automationSchedule(row.trigger)?.startAt ?? floor(model.now() / 60000) * 60000
            next.trigger = .object(["kind": .string("schedule"), "schedule": .object([
                "kind": .string("cron"), "expression": .string(cron.trimmingCharacters(in: .whitespacesAndNewlines)), "timezone": .string(timezone.trimmingCharacters(in: .whitespacesAndNewlines)),
                "startAt": .number(anchor),
            ])])
        }
        guard let automation = next.payload else { problem = "Couldn't encode automation"; return }
        do {
            let reply = try await model.service(["type": "automation.put", "automation": automation], as: AutomationReply.self)
            guard reply.ok else { throw ServiceFailure(message: friendlyAutomationError(reply.error, fallback: "Couldn't save this automation. Check its project and agent, then try again.")) }
            saved(); dismiss()
        } catch { problem = error.localizedDescription }
    }
}
