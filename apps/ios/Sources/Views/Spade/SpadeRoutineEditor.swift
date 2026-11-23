import SwiftUI

/// A routine opened to edit, or a new one, as a sheet: its name, the kind of trigger as three
/// choices with only that kind's fields under it (a time and its days, an interval, or a thread
/// event), and what it does each time. Save, or Cancel to put it back; Delete at the foot of one
/// that exists. The fields' "when it runs" shows under them as it will be saved.
struct SpadeRoutineEditor: View {
    let scope: SpadeProfileScope
    let routine: SpadeRoutineRow?
    let saved: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var draft = SpadeRoutineDraft()
    @State private var saving = false
    @State private var problem: String?
    @State private var deleting = false

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $draft.name, prompt: Text("Morning brief"))
                    .aceFont(AceDesign.TextRole.rowTitle)
                    .accessibilityIdentifier("spade.routine.name")
            }
            Section {
                if draft.keepsSchedule {
                    // A schedule the form can't show (cron, several times a day): kept as it is
                    // until the person sets a new time.
                    Text(draft.words).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                    Button("Choose a new time") { draft.chooseNewTime() }
                        .buttonStyle(.rowAction)
                        .accessibilityIdentifier("spade.routine.newTime")
                } else {
                    Picker("When it runs", selection: $draft.kind) {
                        ForEach(SpadeRoutineDraft.Kind.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                    .accessibilityIdentifier("spade.routine.kind")
                    fields
                }
            } header: {
                Text("When it runs")
            } footer: {
                if !draft.keepsSchedule { Text(draft.words).accessibilityIdentifier("spade.routine.words") }
            }
            Section("Each time") {
                TextEditor(text: $draft.instruction)
                    .aceFont(AceDesign.TextRole.message)
                    .frame(minHeight: AceDesign.Size.rowThread * 2)
                    .accessibilityIdentifier("spade.routine.instruction")
            }
            if let problem {
                Section { Text(problem).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceTheme.StatusText.failed) }
            }
            if routine != nil {
                Section {
                    Button("Delete routine", role: .destructive) { deleting = true }
                        .disabled(saving)
                        .accessibilityIdentifier("spade.routine.delete")
                }
            }
        }
        .disabled(saving)
        .navigationTitle(routine == nil ? "New routine" : "Edit routine")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(saving)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }.disabled(saving).accessibilityIdentifier("spade.routine.cancel")
            }
            ToolbarItem(placement: .confirmationAction) {
                if saving { ProgressView() } else {
                    Button(routine == nil ? "Add" : "Save") { save() }
                        .disabled(!draft.ready)
                        .accessibilityIdentifier("spade.routine.save")
                }
            }
        }
        .confirmationDialog("Delete \(routine?.name ?? "this routine")?", isPresented: $deleting, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { remove() }
        } message: {
            Text("It stops running. Its past runs stay in the chat.")
        }
        .onAppear {
            guard let routine else { return }
            draft = SpadeRoutineDraft(name: routine.name, instruction: routine.instruction,
                                      trigger: routine.trigger, words: routine.line)
        }
    }

    /// Only the chosen kind's fields.
    @ViewBuilder private var fields: some View {
        switch draft.kind {
        case .time:
            DatePicker("At", selection: clock, displayedComponents: .hourAndMinute)
                .accessibilityIdentifier("spade.routine.time")
            NavigationLink {
                SpadeRoutineDays(days: $draft.days)
            } label: {
                LabeledContent("On", value: SpadeRoutineDraft.dayWords(draft.days))
            }
            .accessibilityIdentifier("spade.routine.days")
        case .interval:
            Picker("Every", selection: $draft.everyMinutes) {
                ForEach(draft.intervalChoices, id: \.self) { Text(SpadeRoutineDraft.intervalWords($0)).tag($0) }
            }
            .accessibilityIdentifier("spade.routine.interval")
        case .event:
            Picker("When a thread", selection: $draft.event) {
                ForEach(SpadeRoutineDraft.events, id: \.value) { Text($0.words).tag($0.value) }
            }
            .accessibilityIdentifier("spade.routine.event")
        }
    }

    /// The draft's hour and minute as the picker's date, today.
    private var clock: Binding<Date> {
        Binding(
            get: {
                Calendar.current.date(bySettingHour: draft.hour, minute: draft.minute, second: 0, of: .now) ?? .now
            },
            set: { date in
                let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
                draft.hour = parts.hour ?? draft.hour
                draft.minute = parts.minute ?? draft.minute
            })
    }

    private func save() {
        guard draft.ready, !saving else { return }
        saving = true
        problem = nil
        Task {
            let outcome = await scope.client.spadeSaveRoutine(scope.agent, id: routine?.id, draft: draft)
            saving = false
            guard outcome.ok else { problem = outcome.problem; return }
            await saved()
            dismiss()
        }
    }

    private func remove() {
        guard let routine, !saving else { return }
        saving = true
        problem = nil
        Task {
            let outcome = await scope.client.spadeDeleteRoutine(routine.id)
            saving = false
            guard outcome.ok else { problem = outcome.problem; return }
            await saved()
            dismiss()
        }
    }
}

/// The days a timed routine runs on, as the Clock app's Repeat: each day with a check.
struct SpadeRoutineDays: View {
    @Binding var days: Set<Int>
    /// Monday first, as the week reads.
    private let order = [1, 2, 3, 4, 5, 6, 0]

    var body: some View {
        List {
            ForEach(order, id: \.self) { day in
                Button {
                    if days.contains(day) { days.remove(day) } else { days.insert(day) }
                } label: {
                    HStack {
                        Text("Every \(SpadeRoutineDraft.dayNames[day].capitalized)").foregroundStyle(AceDesign.Ink.primary)
                        Spacer(minLength: AceDesign.Space.related)
                        if days.contains(day) {
                            AceIcon(.check, size: AceDesign.Size.groupGlyph).foregroundStyle(AceDesign.Ink.action)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .accessibilityAddTraits(days.contains(day) ? .isSelected : [])
            }
        }
        .navigationTitle("On")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// The heartbeat opened to edit: how often, the checklist the bot goes through (saying
/// something only when it needs the person), and quiet hours, when it doesn't check. Saving
/// turns it on.
struct SpadeHeartbeatEditor: View {
    let scope: SpadeProfileScope
    let heartbeat: SpadeHeartbeatRow
    let saved: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var everyMinutes = 30
    @State private var checklist = ""
    @State private var quiet = false
    @State private var start = SpadeHeartbeatEditor.date("22:00")
    @State private var end = SpadeHeartbeatEditor.date("07:00")
    @State private var saving = false
    @State private var problem: String?

    private var choices: [Int] {
        let offered = [15, 30, 60, 120, 240]
        return offered.contains(everyMinutes) ? offered : (offered + [everyMinutes]).sorted()
    }
    private var ready: Bool { !checklist.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        Form {
            Section {
                Picker("How often", selection: $everyMinutes) {
                    ForEach(choices, id: \.self) { Text(SpadeRoutineDraft.intervalWords($0)).tag($0) }
                }
                .accessibilityIdentifier("spade.heartbeat.every")
            }
            Section {
                TextEditor(text: $checklist)
                    .aceFont(AceDesign.TextRole.message)
                    .frame(minHeight: AceDesign.Size.rowThread * 2)
                    .accessibilityIdentifier("spade.heartbeat.checklist")
            } header: {
                Text("Checklist")
            } footer: {
                Text("\(scope.name) goes through it and only says something when it needs you.")
            }
            Section {
                Toggle("Quiet hours", isOn: $quiet).accessibilityIdentifier("spade.heartbeat.quiet")
                if quiet {
                    DatePicker("From", selection: $start, displayedComponents: .hourAndMinute)
                    DatePicker("Until", selection: $end, displayedComponents: .hourAndMinute)
                }
            }
            if let problem {
                Section { Text(problem).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceTheme.StatusText.failed) }
            }
        }
        .disabled(saving)
        .navigationTitle("Heartbeat")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(saving)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }.disabled(saving)
            }
            ToolbarItem(placement: .confirmationAction) {
                if saving { ProgressView() } else {
                    Button(heartbeat.enabled ? "Save" : "Turn on") { save() }
                        .disabled(!ready)
                        .accessibilityIdentifier("spade.heartbeat.save")
                }
            }
        }
        .onAppear {
            everyMinutes = heartbeat.everyMinutes
            checklist = heartbeat.checklist
            if let hours = heartbeat.quiet {
                quiet = true
                start = Self.date(hours.start)
                end = Self.date(hours.end)
            }
        }
    }

    private func save() {
        guard ready, !saving else { return }
        saving = true
        problem = nil
        let hours = quiet ? SpadeHeartbeatRow.Quiet(start: Self.clock(start), end: Self.clock(end)) : nil
        Task {
            let outcome = await scope.client.spadeSaveHeartbeat(
                scope.agent, enabled: true, everyMinutes: everyMinutes,
                checklist: checklist.trimmingCharacters(in: .whitespacesAndNewlines), quiet: .some(hours))
            saving = false
            guard outcome.ok else { problem = outcome.problem; return }
            await saved()
            dismiss()
        }
    }

    /// `22:00` as today's date at that time.
    static func date(_ clock: String) -> Date {
        let parts = clock.split(separator: ":").compactMap { Int($0) }
        let hour = parts.first ?? 0
        let minute = parts.count > 1 ? parts[1] : 0
        return Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: .now) ?? .now
    }

    /// A date's time as Spade writes it: `07:00`.
    static func clock(_ date: Date) -> String {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }
}
