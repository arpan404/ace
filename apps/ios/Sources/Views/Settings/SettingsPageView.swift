import SwiftUI

/// Any machine settings page the bridge describes (`settings.page`): its sections and rows as
/// sent, opening on the last kept answer while the machine is read again, with rows held in
/// place while nothing is kept yet. With several machines paired, the top says where changes go;
/// "All machines" sends each change to every connected machine and names the ones that refused
/// it or hold another value.
struct SettingsPageView: View {
    let model: ClientModel
    let page: String
    let fallbackTitle: String
    @Environment(\.settingsScope) private var scope
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var data: SettingsPageData?
    @State private var others: [String: SettingsPageData] = [:]
    @State private var problem: String?
    @State private var rowProblems: [String: String] = [:]
    @State private var pending: [String: SettingsPageInput] = [:]
    @State private var saved = 0
    @State private var failed = 0
    @State private var picking: SettingsPageData.Row?

    init(model: ClientModel, page: String, title: String) {
        self.model = model
        self.page = page
        self.fallbackTitle = title
        _data = State(initialValue: model.kept(SettingsPageData.request(page), as: SettingsPageData.self))
    }

    private var request: [String: Any] { SettingsPageData.request(page) }
    private var spreading: Bool { scope?.all == true && scope?.several == true }
    private var motion: Animation { reduceMotion ? .easeInOut(duration: 0.2) : .smooth }

    var body: some View {
        List {
            if let scope, scope.several { SettingsScopeSection(scope: scope, client: model) }
            if let data {
                ForEach(data.sections) { section in
                    Section {
                        ForEach(section.rows) { row in
                            SettingsPageRowView(
                                model: model, row: row, pending: pending[row.id], others: differences(row),
                                scoped: scope?.several == true,
                                problem: rowProblems[row.id], enabled: model.canOperate && row.locked == nil,
                                change: { change(row, $0) }, pick: { picking = row }
                            )
                            if case .model(_, _, _, _, let clear?) = row.control {
                                SettingsClearRow(row: row, clear: clear, enabled: model.canOperate && row.locked == nil) {
                                    change(row, .pick(nil))
                                }
                                .transition(.opacity)
                            }
                        }
                    } header: {
                        if let title = section.title { InsetHeader(title) }
                    } footer: {
                        if let footer = section.footer { Text(footer) }
                    }
                    .insetRowBackground()
                }
            } else if let problem {
                Section {
                    ServiceProblem(message: problem)
                    Button("Retry") { Task { await read() } }.accessibilityIdentifier("settings.page.retry")
                }
                .insetRowBackground()
            } else {
                // A role's page opens on its one model row; other pages hold a few rows.
                SettingsPagePlaceholder(rows: page.hasPrefix("role.") ? 1 : 5)
            }
        }
        .insetGroupedList()
        .animation(motion, value: data)
        .animation(motion, value: problem)
        .navigationTitle(data?.title ?? fallbackTitle).navigationBarTitleDisplayMode(.inline)
        .task(id: ReadKey(generation: model.readGeneration(request), reconnects: model.reads.reconnects, spreading: spreading)) {
            await read()
        }
        .refreshable { await read() }
        .sensoryFeedback(.selection, trigger: saved)
        .sensoryFeedback(.error, trigger: failed)
        .sheet(item: $picking) { row in
            SettingsModelSheet(model: model, page: page, row: row) { pick in change(row, .pick(pick)) }
        }
        .accessibilityIdentifier("settings.page.\(page)")
    }

    private struct ReadKey: Equatable { let generation: Int; let reconnects: Int; let spreading: Bool }

    private func read() async {
        do {
            let reply = try await model.read(request, as: SettingsPageReply.self)
            switch reply {
            case .page(let page): data = page; problem = nil
            case .refused(let message): problem = message
            }
        } catch is CancellationError {
        } catch { if data == nil { problem = error.localizedDescription } }
        if spreading { await readOthers() } else if !others.isEmpty { others = [:] }
    }
    /// Every other connected machine's copy of the page, to say where values differ.
    private func readOthers() async {
        guard let scope else { return }
        for machine in scope.machines where machine.client !== model && machine.client.connection == "ready" {
            if case .page(let page)? = try? await machine.client.read(request, as: SettingsPageReply.self) {
                others[machine.id] = page
            }
        }
    }
    /// "Mac mini: Steer" for each machine whose value isn't this one's.
    private func differences(_ row: SettingsPageData.Row) -> [String] {
        guard spreading, let scope else { return [] }
        return scope.machines.compactMap { machine in
            guard let other = others[machine.id]?.row(row.id), other.value != row.value else { return nil }
            return "\(machine.name): \(other.shown)"
        }
    }

    private func change(_ row: SettingsPageData.Row, _ input: SettingsPageInput) {
        guard model.canOperate else { return }
        let targets = scope?.targets(from: model).send ?? []
        let machines = targets.isEmpty ? [SettingsScope.Machine(id: "", name: "", client: model)] : targets
        withAnimation(motion) { pending[row.id] = input; rowProblems[row.id] = nil }
        Task {
            var refusals: [(name: String, message: String)] = []
            let (page, id) = (page, row.id)
            // Every machine is asked at once; answers are taken in order.
            let writes = machines.map { machine in
                Task { @MainActor () -> SettingsPageWrite in
                    let payload: [String: Any] = ["type": "settings.page.set", "page": page, "row": id, "value": input.wire]
                    do { return try await machine.client.service(payload, as: SettingsPageWrite.self) }
                    catch { return SettingsPageWrite(ok: false, message: error.localizedDescription, page: nil) }
                }
            }
            for (machine, write) in zip(machines, writes) {
                let reply = await write.value
                if let page = reply.page { place(page, from: machine.client, id: machine.id) }
                if !reply.ok { refusals.append((machine.name, reply.message ?? "This machine didn't save that change.")) }
            }
            withAnimation(motion) {
                pending[row.id] = nil
                rowProblems[row.id] = refusals.isEmpty ? nil : words(refusals, of: machines.count)
            }
            if refusals.isEmpty { saved += 1 } else { failed += 1 }
        }
    }
    private func place(_ page: SettingsPageData, from client: ClientModel, id: String) {
        withAnimation(motion) {
            if client === model { data = page } else { others[id] = page }
        }
    }
    private func words(_ refusals: [(name: String, message: String)], of count: Int) -> String {
        if count == 1, let only = refusals.first { return only.message }
        return refusals.map { "Not saved on \($0.name): \($0.message)" }.joined(separator: "\n")
    }
}

/// A page read answers with the page, or says the machine doesn't have it.
enum SettingsPageReply: Decodable, Sendable {
    case page(SettingsPageData), refused(String)
    init(from decoder: any Decoder) throws {
        if let page = try? SettingsPageData(from: decoder) { self = .page(page); return }
        self = .refused(try SettingsPageRefusal(from: decoder).message)
    }
}

/// Rows held in place while a page reads for the first time, so nothing jumps when it arrives.
private struct SettingsPagePlaceholder: View {
    let rows: Int
    var body: some View {
        Section {
            ForEach(0..<rows, id: \.self) { _ in
                HStack { Text("Setting name here"); Spacer(); Text("Value") }
                    .aceFont(InsetStyle.label, relativeTo: .body)
            }
        }
        .insetRowBackground()
        .redacted(reason: .placeholder)
        .accessibilityHidden(true)
    }
}

/// "Clear" in red, or "Use Auto", as its own row under a set model. It asks first only when
/// clearing discards more than the model (the bridge says so).
private struct SettingsClearRow: View {
    let row: SettingsPageData.Row
    let clear: SettingsPageData.Clear
    let enabled: Bool
    let run: () -> Void
    @State private var asking = false
    var body: some View {
        // The list's own button, as Remove on a machine's page: red when it discards.
        Button(clear.label, role: clear.destructive ? .destructive : nil) {
            if clear.ask == nil { run() } else { asking = true }
        }
        .foregroundStyle(clear.destructive ? Color(uiColor: .systemRed) : AceTheme.Colours.foreground)
        .disabled(!enabled)
        .accessibilityIdentifier("setting.\(row.id).clear")
        .confirmationDialog(clear.ask?.title ?? "", isPresented: $asking, titleVisibility: .visible) {
            Button(clear.ask?.confirm ?? clear.label, role: .destructive, action: run)
            Button("Cancel", role: .cancel) {}
        } message: { Text(clear.ask?.message ?? "") }
    }
}
