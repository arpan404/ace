import Foundation
import Observation

/// A bot's computer as its pages follow it (web's `use-bot-computer.ts`): read while one of them
/// shows with the app in front, and again right after Take over or Hand back. The person's input
/// goes in only on Spade's word from a read that went: not once the app left the front or the
/// connection changed (`forget`), not while a change of hands is on its way or after one whose
/// read didn't come back, and not once the poll is overdue, so a stalled read never leaves old
/// permission standing.
@MainActor @Observable final class SpadeComputerWatch {
    typealias Ask = @MainActor () async -> SpadeComputerReply
    let agent: String
    private(set) var state: SpadeComputerState?
    /// Changes when previously queued input loses its permission.
    private(set) var permissionGeneration = 0
    private var readEpoch: Int?
    /// When the state was read, while it may be trusted.
    private(set) var readAt: ContinuousClock.Instant?
    /// Take over or Hand back is on its way.
    private(set) var pending = false
    /// What Take over or Hand back met, for the page's alert.
    var problem: String?
    /// Bumps on every read and change of hands: a read started before one is dropped.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private let now: () -> ContinuousClock.Instant
    @ObservationIgnored private let sleep: (Duration) async throws -> Void
    static let every: Duration = .seconds(3)
    /// A read older than this is overdue: the poll stalled, and what it said lapses.
    static let lapse: Duration = .seconds(8)

    init(agent: String, now: @escaping () -> ContinuousClock.Instant = { ContinuousClock.now },
         sleep: @escaping (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.agent = agent
        self.now = now
        self.sleep = sleep
    }

    /// Spade's fresh word lets the person act, with the phone connected and allowed to.
    func mayAct(connected: Bool) -> Bool {
        guard connected, !pending, let readAt, state?.mayAct == true else { return false }
        return now() - readAt <= Self.lapse
    }

    func mayAct(_ model: ClientModel) -> Bool {
        readEpoch == model.connectionEpoch && mayAct(connected: model.connection == "ready" && model.canOperate)
    }

    /// The person holds the computer on Spade's fresh word (exclusive, they drive). Only then
    /// does the bot's screen take their touches and keys; cowork leaves it to watch.
    func holds(connected: Bool) -> Bool { state?.driving == true && mayAct(connected: connected) }

    func holds(_ model: ClientModel) -> Bool { state?.driving == true && mayAct(model) }

    func expire(_ stamp: ContinuousClock.Instant) async {
        do { try await sleep(max(.zero, Self.lapse - (now() - stamp))) } catch { return }
        guard !Task.isCancelled, readAt == stamp else { return }
        revoke()
    }

    private func revoke() {
        readAt = nil
        permissionGeneration += 1
    }

    private func accept(_ computer: SpadeComputerState, epoch: Int?) {
        if !computer.mayAct || !mayAct(connected: true) || readEpoch != epoch {
            permissionGeneration += 1
        }
        state = computer
        readEpoch = epoch
        readAt = now()
    }

    /// The app left the front or the connection changed: nothing is trusted until a fresh read.
    func forget() {
        generation += 1
        revoke()
    }

    /// Read now, then every few seconds until the caller's task is cancelled.
    func follow(epoch: Int, _ ask: Ask) async {
        while !Task.isCancelled {
            await read(epoch: epoch, ask)
            do { try await sleep(Self.every) } catch { return }
        }
    }

    func read(epoch: Int? = nil, _ ask: Ask) async {
        // A change of hands is on its way: its own read says what holds after it.
        guard !pending else { return }
        generation += 1
        let asked = generation
        let reply = await ask()
        guard asked == generation, !Task.isCancelled else { return }
        if let computer = reply.computer {
            accept(computer, epoch: epoch)
        } else {
            revoke()
        }
    }

    /// Take over (the bot pauses until handed back), or hand back. What was trusted before goes
    /// at once: only the read that follows the change says what the person may do.
    func take(epoch: Int? = nil, _ ask: Ask) async {
        guard !pending else { return }
        pending = true
        forget()
        let asked = generation
        let reply = await ask()
        pending = false
        guard asked == generation, !Task.isCancelled else { return }
        if let computer = reply.computer {
            generation += 1
            accept(computer, epoch: epoch)
        } else if let problem = reply.problem {
            self.problem = problem
        }
    }
}
