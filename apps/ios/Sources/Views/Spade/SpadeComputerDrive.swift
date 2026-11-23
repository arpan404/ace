import SwiftUI

/// Why a change to the bot's files can't be made now: the computer is changing hands.
let spadeNotNowToChange = "Files can change once the computer is yours or shared again"

/// A bot's computer as its pages follow it (web's `use-bot-computer.ts`): read while one of them
/// shows with the app in front, and again right after Take over or Hand back. The person's input
/// goes in only on Spade's word from a read that went, with no change of hands on its way and the
/// phone connected: never from a stale read.
@MainActor @Observable final class SpadeComputerWatch {
    let agent: String
    private(set) var state: SpadeComputerState?
    /// The last read failed: what Spade said may be out of date until one goes.
    private(set) var stale = false
    /// Take over or Hand back is on its way.
    private(set) var pending = false
    /// What Take over or Hand back met, for the page's alert.
    var problem: String?
    /// Bumps on every read that counts; a read started before a newer one landed is dropped.
    @ObservationIgnored private var generation = 0
    static let every: Duration = .seconds(3)

    init(agent: String) { self.agent = agent }

    func mayAct(_ model: ClientModel) -> Bool {
        state?.mayAct == true && !stale && !pending && model.connection == "ready" && model.canOperate
    }

    /// Read now, then every few seconds until the page goes or the app leaves the front.
    func follow(_ model: ClientModel) async {
        while !Task.isCancelled {
            await read(model)
            do { try await Task.sleep(for: Self.every) } catch { return }
        }
    }

    func read(_ model: ClientModel) async {
        generation += 1
        let asked = generation
        let reply = await model.spadeComputerRead(agent)
        guard asked == generation, !Task.isCancelled else { return }
        if let computer = reply.computer { state = computer; stale = false } else { stale = true }
    }

    /// Take over (the bot pauses until handed back), or hand back.
    func take(_ model: ClientModel, _ take: Bool) async {
        pending = true
        generation += 1
        let reply = await model.spadeComputerTake(agent, take: take)
        pending = false
        if let computer = reply.computer {
            generation += 1
            state = computer
            stale = false
        } else if let problem = reply.problem {
            self.problem = problem
        }
    }
}

/// Who has the computer, under what it shows (web's `drive-line.tsx`): the bot's face, moving,
/// and "Writer is using the browser" with Take over while it drives; "You have the browser" with
/// Hand back once the person took over; "Stopping Writer…" while its work ends. While neither
/// uses it, one quiet sentence, with no face and no button.
struct SpadeDriveLineView: View {
    let model: ClientModel
    let watch: SpadeComputerWatch
    /// "browser", "screen", "terminal" or "files": which surface's line.
    let kind: String
    let face: SpadeModel.Face

    var body: some View {
        if let drive = watch.state?.drive[kind] {
            if let action = drive.action {
                HStack(spacing: AceDesign.Space.related) {
                    if drive.face { SpadeFaceView(face: face, size: AceDesign.Size.emptyIcon, pose: .working) }
                    Text(drive.sentence)
                        .aceFont(AceDesign.TextRole.segment)
                        .foregroundStyle(AceDesign.Ink.primary)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button(action == "hand-back" ? "Hand back" : "Take over") {
                        Task { await watch.take(model, action != "hand-back") }
                    }
                    .buttonStyle(.secondaryAction)
                    .frame(minHeight: AceDesign.Size.tap)
                    .disabled(watch.pending || model.connection != "ready" || !model.canOperate)
                    .accessibilityIdentifier("spade.computer.\(action)")
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.updatesFrequently)
            } else {
                Text(drive.sentence)
                    .aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(AceDesign.Ink.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

extension View {
    /// Follows the bot's computer while this page shows with the app in front, and says what Take
    /// over or Hand back met.
    func followsComputer(_ watch: SpadeComputerWatch, model: ClientModel) -> some View {
        modifier(FollowsComputer(watch: watch, model: model))
    }
}

private struct FollowsComputer: ViewModifier {
    let watch: SpadeComputerWatch
    let model: ClientModel
    @Environment(\.scenePhase) private var scene

    func body(content: Content) -> some View {
        content
            .task(id: "\(scene)-\(model.connection)") {
                guard scene == .active, model.connection == "ready" else { return }
                await watch.follow(model)
            }
            .alert("That didn't go", isPresented: Binding(get: { watch.problem != nil }, set: { if !$0 { watch.problem = nil } })) {
                Button("Close", role: .cancel) { watch.problem = nil }
            } message: { Text(watch.problem ?? "") }
    }
}
