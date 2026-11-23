import SwiftUI

/// Routines (ADR 0129): one row each with its name, when it runs in words (or that its last run
/// failed, or that it's paused) and a switch that pauses it; a swipe or a long press for Run
/// now, Edit and Delete, and a tap to edit. The heartbeat is its own row with the same editor,
/// and Add routine sits at the foot. Read on its own as the section shows, with the profile's
/// preview standing in until it lands (and wherever the sheet set no scope).
struct SpadeProfileRoutines: View {
    let routines: SpadeProfile.Part<SpadeProfile.Routine>
    let name: String
    let retry: () -> Void
    @Environment(\.spadeProfileScope) private var scope
    @State private var read: SpadeRoutinesAnswer?
    @State private var problem: String?
    @State private var editing: Editing?
    @State private var deleting: SpadeRoutineRow?
    /// Switches turned while their write is out, by routine id (`heartbeat` for the heartbeat).
    @State private var turning: [String: Bool] = [:]

    enum Editing: Identifiable {
        case routine(SpadeRoutineRow), new, heartbeat(SpadeHeartbeatRow)
        var id: String {
            switch self {
            case .routine(let row): "routine:\(row.id)"
            case .new: "new"
            case .heartbeat: "heartbeat"
            }
        }
    }

    var body: some View {
        Section {
            if let scope, let rows = read?.routines {
                ForEach(rows) { routine in row(routine, scope: scope) }
                if let beat = read?.heartbeat { heartbeatRow(beat, scope: scope) }
                Button { editing = .new } label: { AddRow("Add routine") }
                    .accessibilityIdentifier("spade.routines.add")
            } else if scope != nil, let problem = read?.problem {
                ProblemRow(problem, id: "spade.routines.problem") { Task { await load() } }
            } else {
                preview
            }
        } header: {
            Text("Routines")
        } footer: {
            if let problem { Text(problem).foregroundStyle(AceTheme.StatusText.failed) }
        }
        .task(id: scope?.agent) { await load() }
        // The sheet was pulled or read again: so is this.
        .onChange(of: routines) { Task { await load() } }
        .sheet(item: $editing) { editing in
            if let scope {
                NavigationStack { editor(editing, scope: scope) }
            }
        }
        .confirmationDialog(deleting.map { "Delete \($0.name)?" } ?? "", isPresented: deletingShown, titleVisibility: .visible,
                            presenting: deleting) { routine in
            Button("Delete", role: .destructive) { act(routine.id) { await $0.client.spadeDeleteRoutine(routine.id) } }
        } message: { _ in
            Text("It stops running. Its past runs stay in the chat.")
        }
    }

    /// The profile's own preview: what it read, to look at.
    private var preview: some View {
        SpadeProfileRows(part: routines, none: "\(name) has no routines yet.",
                         failed: "Couldn't read the routines.", retry: retry) { routine in
            lines(name: routine.name, line: routine.line, failed: routine.failed)
        }
    }

    private func lines(name: String, line: String, failed: Bool) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            Text(name).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
            Text(line)
                .aceFont(AceDesign.TextRole.meta)
                .foregroundStyle(failed ? AceTheme.StatusText.failed : AceDesign.Ink.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func row(_ routine: SpadeRoutineRow, scope: SpadeProfileScope) -> some View {
        let on = Binding(
            get: { !(turning[routine.id].map { !$0 } ?? routine.paused) },
            set: { on in
                turning[routine.id] = on
                act(routine.id) { await $0.client.spadePauseRoutine(routine.id, paused: !on) }
            })
        return HStack(spacing: AceDesign.Space.row) {
            Button { editing = .routine(routine) } label: {
                lines(name: routine.name, line: routine.line, failed: routine.failed).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens it to edit")
            Toggle(routine.name, isOn: on)
                .labelsHidden()
                .disabled(turning[routine.id] != nil)
                .accessibilityIdentifier("spade.routine.switch")
        }
        .swipeActions(edge: .trailing) {
            Button("Delete", ace: .trash, role: .destructive) { deleting = routine }
            if !routine.paused {
                Button("Run now", ace: .play) { act(routine.id) { await $0.client.spadeRunRoutine(routine.id) } }
                    .tint(AceDesign.Ink.action)
            }
        }
        .contextMenu {
            if !routine.paused {
                Button("Run now", ace: .play) { act(routine.id) { await $0.client.spadeRunRoutine(routine.id) } }
            }
            Button("Edit", ace: .pencilSimple) { editing = .routine(routine) }
            Button("Delete", ace: .trash, role: .destructive) { deleting = routine }
        }
        .accessibilityIdentifier("spade.routine.\(routine.id)")
    }

    private func heartbeatRow(_ beat: SpadeHeartbeatRow, scope: SpadeProfileScope) -> some View {
        let on = Binding(
            get: { turning["heartbeat"] ?? beat.enabled },
            set: { on in
                // Nothing to go through yet: the checklist comes first.
                if on && beat.checklist.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    editing = .heartbeat(beat)
                    return
                }
                turning["heartbeat"] = on
                act("heartbeat") { await $0.client.spadeSaveHeartbeat($0.agent, enabled: on) }
            })
        return HStack(spacing: AceDesign.Space.row) {
            Button { editing = .heartbeat(beat) } label: {
                lines(name: "Heartbeat", line: beat.line, failed: false).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens it to edit")
            Toggle("Heartbeat", isOn: on)
                .labelsHidden()
                .disabled(turning["heartbeat"] != nil)
                .accessibilityIdentifier("spade.heartbeat.switch")
        }
        .contextMenu { Button("Edit", ace: .pencilSimple) { editing = .heartbeat(beat) } }
    }

    @ViewBuilder private func editor(_ editing: Editing, scope: SpadeProfileScope) -> some View {
        switch editing {
        case .routine(let routine):
            SpadeRoutineEditor(scope: scope, routine: routine, saved: load)
        case .new:
            SpadeRoutineEditor(scope: scope, routine: nil, saved: load)
        case .heartbeat(let beat):
            SpadeHeartbeatEditor(scope: scope, heartbeat: beat, saved: load)
        }
    }

    private var deletingShown: Binding<Bool> {
        Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    }

    /// One action on a row: what went wrong shows under the section, and the list is read again.
    private func act(_ key: String, _ work: @escaping (SpadeProfileScope) async -> SpadeOutcome) {
        guard let scope else { return }
        problem = nil
        Task {
            let outcome = await work(scope)
            if !outcome.ok { problem = outcome.problem }
            await load()
            turning[key] = nil
        }
    }

    private func load() async {
        guard let scope else { return }
        let answer = await scope.client.spadeRoutines(scope.agent)
        // A read that failed keeps the list already shown.
        if answer.ok || read?.routines == nil { read = answer }
    }
}
