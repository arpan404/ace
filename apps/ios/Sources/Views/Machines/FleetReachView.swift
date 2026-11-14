import SwiftUI

/// One machine on the Fleet map: how it's reached, as the web's reach rows say it (its ace
/// account, Tailscale and the local network, each a dot, a sentence and an action), what the map
/// knows about it, and its page. Turning a network off asks first while devices or machines
/// reach it now; the question comes from the bridge.
struct FleetReachView: View {
    let rowId: String
    @Binding var reply: FleetMapReply?
    let reads: FleetMapReads
    let reload: () async -> Void

    @State private var asking: (question: FleetMapReply.Question, row: FleetMapReply.ReachRow, action: FleetMapReply.ReachAction)?
    @State private var saving: String?
    @State private var problem: String?
    @State private var saved = 0

    private var row: FleetMapReply.Row? { reply?.rows.first { $0.id == rowId } }
    private var reach: FleetMapReply.Reach? { reply?.reach.first { $0.id == rowId } }

    var body: some View {
        List {
            if let row {
                Section { FleetMapRowLabel(row: row, line: row.state) }.insetRowBackground()
                Section {
                    if let reach {
                        ForEach(reach.rows) { entry in reachRow(entry) }
                    } else {
                        Text("Shown once this phone reaches \(row.name).").font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                    }
                } header: { InsetHeader("How it's reached") }
                .insetRowBackground()
                if !row.lines.isEmpty {
                    Section {
                        ForEach(row.lines, id: \.self) { line in LabeledContent(line.label, value: line.value) }
                    }
                    .insetRowBackground()
                }
                if let problem {
                    Section { ServiceProblem(message: problem) }.insetRowBackground()
                }
                Section {
                    NavigationLink(value: SettingsRoute.machine(row.id)) { InsetRow("Machine page", systemImage: "info.circle") }
                        .accessibilityIdentifier("fleetReach.page")
                }
                .insetRowBackground()
            }
        }
        .insetGroupedList()
        .smoothChange(reach)
        .sensoryFeedback(.success, trigger: saved)
        .navigationTitle(row?.name ?? "Machine").navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload() }
        .confirmationDialog(asking?.question.title ?? "", isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } }),
                            titleVisibility: .visible) {
            Button(asking?.question.confirm ?? "Turn off", role: .destructive) {
                if let asking { Task { await write(asking.row, asking.action) } }
            }
        } message: { Text(asking?.question.body ?? "") }
    }

    private func reachRow(_ entry: FleetMapReply.ReachRow) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.row) {
            FleetDot(token: entry.token)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(entry.title).font(AceDesign.Typeface.body).foregroundStyle(AceDesign.Ink.primary)
                Text(entry.words).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: AceDesign.Space.related)
            if let action = entry.action {
                Button(saving == entry.id ? "Saving…" : action.label) {
                    if let question = action.confirm { asking = (question, entry, action) }
                    else { Task { await write(entry, action) } }
                }
                .buttonStyle(.textAction(action.value ? .prominent : .plain))
                .disabled(saving != nil)
                .accessibilityIdentifier("fleetReach.\(entry.id).action")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("fleetReach.\(entry.id)")
    }

    private func write(_ entry: FleetMapReply.ReachRow, _ action: FleetMapReply.ReachAction) async {
        saving = entry.id
        defer { saving = nil }
        problem = await reads.set(action.key, action.value, on: rowId)
        if problem == nil { saved += 1 }
        await reload()
    }
}
