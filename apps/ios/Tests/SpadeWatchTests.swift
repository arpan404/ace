import Foundation
import Testing
@testable import Ace

/// The Spade tab's watch: every machine in its list reads its bots while the tab shows, the
/// rest stop, and none read once the tab goes.
@Suite @MainActor struct SpadeWatchTests {
    @Test func everyListedMachineReadsItsBotsAndOneThatLeavesTheListStops() async throws {
        let (home, homeSession) = try await connected("home")
        let (work, workSession) = try await connected("work")
        let (spare, spareSession) = try await connected("spare")
        let watch = SpadeWatch()
        _ = watch.hold([home, work], on: true, among: [home, work, spare])
        _ = watch.hold([work], on: true, among: [home, work, spare])
        #expect(homeSession.watches == [true, false])
        #expect(workSession.watches == [true])
        #expect(spareSession.watches == [])
    }
    @Test func theWatchedMachinesStopReadingWhenTheTabGoes() async throws {
        let (home, session) = try await connected("home")
        let (work, workSession) = try await connected("work")
        let watch = SpadeWatch()
        let hold = watch.hold([home, work], on: true, among: [home, work])
        watch.release(hold)
        #expect(session.watches == [true, false])
        #expect(workSession.watches == [true, false])
        // Spade back on with Threads showing: a new runtime isn't told to read the bots again.
        home.spadeResume()
        #expect(session.watches == [true, false])
    }
    @Test func aMachineThatStopsShowingSpadeStopsReading() async throws {
        let (home, session) = try await connected("home")
        let watch = SpadeWatch()
        _ = watch.hold([home], on: true, among: [home])
        _ = watch.hold([], on: true, among: [])
        #expect(session.watches == [true, false])
    }
    @Test func anEarlierHoldEndingLateLeavesTheNewerWatchReading() async throws {
        let (home, session) = try await connected("home")
        let watch = SpadeWatch()
        let hidden = watch.hold([home], on: false, among: [home])
        _ = watch.hold([home], on: true, among: [home])
        watch.release(hidden)
        #expect(session.watches == [true])
    }

    private func connected(_ host: String) async throws -> (ClientModel, WatchRecorder) {
        let session = WatchRecorder()
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: { _, _, _, _ in session })
        let target = ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:1")), hostId: host, deviceId: "device", pin: nil,
                                      credential: { "{}" })
        await model.connect(target: target, directory: FileManager.default.temporaryDirectory)
        return (model, session)
    }
}

private final class WatchRecorder: ClientSession, @unchecked Sendable {
    private let lock = NSLock()
    private var sent: [Bool] = []
    /// Every `spade.watch` the bridge was told, in order.
    var watches: [Bool] { lock.withLock { sent } }
    func start(itemLimit: Int) {}
    func invoke(_ name: String, json: String) {
        guard let value = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
              value["type"] as? String == "spade.watch", let on = value["on"] as? Bool else { return }
        lock.withLock { sent.append(on) }
    }
    func acknowledge(accepted: Bool) {}
    func stop(completion: @escaping @Sendable () -> Void) { completion() }
}
