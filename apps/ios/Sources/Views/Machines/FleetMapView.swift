import SwiftUI

struct FleetMapView: View {
    let inbox: MachineInbox
    let machines: MachinesModel?

    @Environment(\.settingsPush) private var push
    @State private var mapSelection: String?
    @State private var reply: FleetMapReply?
    @State private var problem: String?
    @State private var hints: [String: String] = [:]
    @State private var asking: (question: FleetMapReply.Question, action: FleetMapReply.Action)?
    @State private var busy = false
    @State private var done = 0
    /// Each load's number: only the newest draws, so a slow older read never redraws over a change.
    @State private var loads = 0

    private var reads: FleetMapReads { FleetMapReads(inbox: inbox, machines: machines) }

    var body: some View {
        List {
            if let reply {
                Section {
                    if let picture = reply.picture {
                        FleetMapCanvas(picture: picture, summary: reply.summary) { mapSelection = $0 }
                    } else {
                        Text(reply.summary).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                            .accessibilityIdentifier("fleetMap.summary")
                    }
                }
                .listRowBackground(Color.clear)
                if !reply.needing.isEmpty {
                    Section {
                        ForEach(reply.needing) { row in problemRow(row) }
                    } header: { InsetHeader("Needs you") }
                    .insetRowBackground()
                }
                Section {
                    ForEach(reply.machines) { row in detailLink(row) }
                } header: { InsetHeader("Machines") }
                .insetRowBackground()
                if !reply.devices.isEmpty {
                    Section {
                        ForEach(reply.devices) { row in detailLink(row) }
                    } header: { InsetHeader("Devices") }
                    .insetRowBackground()
                }
            } else if problem == nil {
                Section {
                    ForEach(["studio", "mini", "iPhone"], id: \.self) { name in
                        LabeledContent(name) { Text("Connected") }.redacted(reason: .placeholder)
                    }
                    .accessibilityHidden(true)
                }
                .insetRowBackground()
            }
            if let problem { ProblemRow(problem, id: "fleetMap.problem") { Task { await load() } } }
        }
        .insetGroupedList()
        .navigationDestination(item: $mapSelection) { detail($0) }
        .smoothChange(reply)
        .sensoryFeedback(.success, trigger: done)
        .navigationTitle("Fleet map").navigationBarTitleDisplayMode(.inline)
        .task(id: inbox.sessions.map { "\($0.hostId):\($0.client.connection)" }) { await load() }
        .refreshable { await load() }
        .confirmationDialog(asking?.question.title ?? "", isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } }),
                            titleVisibility: .visible) {
            Button(asking?.question.confirm ?? "Continue", role: .destructive) {
                if let action = asking?.action { Task { await run(action) } }
            }
        } message: { Text(asking?.question.body ?? "") }
    }

    private func detailLink(_ row: FleetMapReply.Row) -> some View {
        NavigationLink { detail(row.id) } label: { FleetMapRowLabel(row: row) }
            .accessibilityIdentifier("fleetMap.\(row.kind).\(row.id)")
    }

    private func detail(_ id: String) -> some View {
        FleetReachView(rowId: id, reply: $reply, reads: reads, reload: load)
    }

    /// A node that needs the person: its state, what's wrong and why, and its fixes as buttons.
    private func problemRow(_ row: FleetMapReply.Row) -> some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            FleetMapRowLabel(row: row, line: row.state)
            if let problem = row.problem {
                Text(problem.what).font(AceDesign.Typeface.body).foregroundStyle(AceDesign.Ink.primary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(problem.why).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let hint = hints[row.id] {
                Text(hint).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("fleetMap.hint.\(row.id)")
            }
            HStack(spacing: AceDesign.Space.related) {
                ForEach(row.fixes) { fix in
                    let button = Button(fix.label) { tapped(fix, row: row) }
                    Group { if fix.primary { button.buttonStyle(.primaryAction) } else { button.buttonStyle(.secondaryAction) } }
                        .disabled(busy || (fix.action.kind == "hint" && hints[row.id] != nil))
                        .accessibilityIdentifier("fleetMap.fix.\(row.id).\(fix.id)")
                }
            }
        }
        .padding(.vertical, AceTheme.Spacing.xxs)
        .accessibilityIdentifier("fleetMap.problem.\(row.id)")
    }

    private func tapped(_ fix: FleetMapReply.Fix, row: FleetMapReply.Row) {
        switch fix.action.kind {
        case "open": if let machine = fix.action.machine { push(.machine(machine)) }
        case "hint": hints[row.id] = fix.action.text
        default:
            if let question = fix.action.confirm { asking = (question, fix.action) }
            else { Task { await run(fix.action) } }
        }
    }

    private func run(_ action: FleetMapReply.Action) async {
        busy = true
        defer { busy = false }
        if let failed = await reads.run(action) { problem = failed; return }
        done += 1
        await load()
    }

    private func load() async {
        loads += 1
        let mine = loads
        let failed = await reads.load { if mine == loads { reply = $0 } }
        guard mine == loads else { return }
        // A machine that couldn't be read is in the map already; say so only when nothing came back.
        problem = reply == nil ? failed ?? "No machines connected. Reconnect and retry." : nil
    }
}

/// A row of the map: the state's dot, the machine's or device's mark, its name and one line.
struct FleetMapRowLabel: View {
    let row: FleetMapReply.Row
    var line: String?
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        HStack(spacing: AceDesign.Space.row) {
            FleetDot(token: row.token)
            AceIcon(FleetMapReply.icon(row.art), size: AceDesign.Size.icon, relativeTo: .body).foregroundStyle(AceDesign.Ink.primary)
                .frame(width: AceDesign.Size.icon + AceDesign.Space.related).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(row.name).font(AceDesign.Typeface.body).foregroundStyle(AceDesign.Ink.primary)
                Text(line ?? row.line).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                    .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(row.state)
    }
}

/// A status dot in a shared token's colour; its meaning is in the row's words.
struct FleetDot: View {
    let token: String
    var body: some View {
        Circle().fill(StateStyle.marker(token)).frame(width: AceTheme.Dimensions.statusDot, height: AceTheme.Dimensions.statusDot)
            .accessibilityHidden(true)
    }
}
