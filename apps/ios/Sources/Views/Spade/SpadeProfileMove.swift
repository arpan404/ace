import SwiftUI

/// Another of the person's machines that runs Spade, which a bot can move to (ADR 0187).
struct SpadeMoveTarget: Identifiable {
    /// Its ace host id, as Spade names machines.
    let host: String
    let name: String
    /// Its connection is ready and its Spade answers now.
    let ready: Bool
    let client: ClientModel
    var id: String { host }
}

extension EnvironmentValues {
    /// The space's machines that run Spade, for a profile's Move to….
    @Entry var spadeMoveTargets: [SpadeMoveTarget] = []
}

/// A bot's move to another machine as its profile drives it (ADR 0187), as web's: started on the
/// machine the bot is on, then, once packed, accepted by the person on the machine it goes to,
/// exactly as packed, since each machine runs in its own runtime. While it moves the sentence
/// says how far; a refusal says why.
@MainActor @Observable final class SpadeMoveFlow {
    private(set) var row: SpadeProfileAccess.Move?
    private(set) var busy = false
    private(set) var problem: String?
    @ObservationIgnored private let client: ClientModel
    @ObservationIgnored private let agent: String

    init(client: ClientModel, agent: String) {
        self.client = client
        self.agent = agent
    }

    struct Confirmation {
        let target: SpadeMoveTarget
        let moveId: String?
    }

    var confirmation: Confirmation?
    private var approvedId: String?
    private(set) var acceptedId: String?
    private var revision = 0
    private var loaded = false

    var moveId: String? { row?.id }

    func watch(targets: [SpadeMoveTarget]) async {
        await read(targets: targets)
        while !loaded || row?.moving == true {
            do { try await Task.sleep(for: .seconds(2)) }
            catch { return }
            await read(targets: targets)
        }
    }

    private func read(targets: [SpadeMoveTarget]) async {
        guard !busy else { return }
        let revision = self.revision
        let answer = await client.spadeMove(agent)
        guard !Task.isCancelled, revision == self.revision, answer.ok else { return }
        loaded = true
        row = answer.part
        if let row, row.id == approvedId, row.waitsForYou,
           let target = targets.first(where: { $0.host == row.to && $0.ready }) {
            await accept(row, on: target)
        }
    }

    func confirm(_ choice: Confirmation) async {
        guard !busy, choice.target.ready else { return }
        if let id = choice.moveId {
            guard let row, row.id == id, row.to == choice.target.host, row.waitsForYou else { return }
            await accept(row, on: choice.target)
            return
        }
        guard row?.moving != true else { return }
        busy = true
        revision += 1
        problem = nil
        let id = SpadeProfileAccess.moveId(UUID())
        let started = await client.spadeMoveStart(agent, to: choice.target.host, move: id)
        busy = false
        guard started.ok else {
            problem = started.problem ?? "Couldn't move it."
            return
        }
        row = started.part
        approvedId = id
        client.spadeRefresh()
        if let row, row.waitsForYou { await accept(row, on: choice.target) }
    }

    private func accept(_ row: SpadeProfileAccess.Move, on target: SpadeMoveTarget) async {
        guard let id = row.id, let accept = row.accept else { return }
        busy = true
        revision += 1
        approvedId = nil
        problem = nil
        let accepted = await target.client.spadeMoveAccept(id, accept: accept)
        busy = false
        if accepted.ok { acceptedId = id }
        else { problem = accepted.problem ?? "\(target.name) didn't take it." }
        client.spadeRefresh()
        target.client.spadeRefresh()
    }

    /// `cancel` (also dismisses a failed move), `check` or `arrival`.
    func end(_ action: String, targets: [SpadeMoveTarget]) async {
        guard !busy else { return }
        busy = true
        revision += 1
        approvedId = nil
        problem = nil
        let outcome = await client.spadeMoveEnd(agent, action: action)
        busy = false
        if !outcome.ok { problem = outcome.problem }
        await read(targets: targets)
    }
}

/// The bot's move, or what needs the person since it arrived, as one sentence at the top of
/// Details with its text buttons. Read as Details shows, and every two seconds while it moves.
struct SpadeMoveLine: View {
    let flow: SpadeMoveFlow
    let targets: [SpadeMoveTarget]

    var body: some View {
        Group {
            if let row = flow.row {
                Section {
                    Text(row.line)
                        .aceFont(AceDesign.TextRole.message)
                        .foregroundStyle(row.failed ? AceTheme.StatusText.failed : AceDesign.Ink.primary)
                        .accessibilityIdentifier("spade.move.line")
                    actions(row)
                }
            }
            if let problem = flow.problem {
                Text(problem).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceTheme.StatusText.failed)
            }
        }
    }

    @ViewBuilder private func actions(_ row: SpadeProfileAccess.Move) -> some View {
        HStack(spacing: AceDesign.Space.group) {
            if row.canCancel { button("Cancel") { await flow.end("cancel", targets: targets) } }
            if row.check { button("Check again") { await flow.end("check", targets: targets) } }
            if row.canKeep { button("Keep it here") { await flow.end("cancel", targets: targets) } }
            if row.failed {
                if let target = targets.first(where: { $0.host == row.to && $0.ready }) {
                    confirmButton("Try again", target: target, id: nil)
                }
                button("Dismiss") { await flow.end("cancel", targets: targets) }
            }
            if row.waitsForYou, let id = row.id, id != flow.acceptedId,
               let target = targets.first(where: { $0.host == row.to && $0.ready }) {
                confirmButton("Continue move", target: target, id: id)
            }
            if row.arrived { button("Dismiss") { await flow.end("arrival", targets: targets) } }
        }
    }

    private func confirmButton(_ title: String, target: SpadeMoveTarget, id: String?) -> some View {
        Button(title) { flow.confirmation = .init(target: target, moveId: id) }
            .aceFont(AceDesign.TextRole.action)
            .buttonStyle(.borderless)
            .disabled(flow.busy)
    }

    private func button(_ title: String, _ act: @escaping () async -> Void) -> some View {
        Button(title) { Task { await act() } }
            .aceFont(AceDesign.TextRole.action)
            .buttonStyle(.borderless)
            .disabled(flow.busy)
    }
}

/// The Machine row's Move to…: the person's other machines that run Spade, one offline named so.
/// Not while it moves, nor with nowhere to go.
struct SpadeMoveMenu: View {
    let flow: SpadeMoveFlow
    let targets: [SpadeMoveTarget]
    let name: String

    var body: some View {
        if flow.row?.moving != true && !targets.isEmpty {
            Menu("Move to…") {
                ForEach(targets) { target in
                    Button(target.ready ? target.name : "\(target.name) · offline") {
                        flow.confirmation = .init(target: target, moveId: nil)
                    }
                    .disabled(!target.ready)
                }
            }
            .disabled(flow.busy)
            .accessibilityLabel("Move \(name) to another machine")
            .accessibilityIdentifier("spade.profile.move")
        }
    }
}
