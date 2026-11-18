import Foundation
import Testing
@testable import Ace

/// The Spade tab's watch: only the machine on screen reads its bots, and none once the tab goes.
@Suite @MainActor struct SpadeWatchTests {
    @Test func theShownMachineReadsItsBotsAndTheOthersStop() async throws {
        let (home, homeSession) = try await connected("home")
        let (work, workSession) = try await connected("work")
        let watch = SpadeWatch()
        _ = watch.hold(home, on: true, among: [home, work])
        _ = watch.hold(work, on: true, among: [home, work])
        #expect(homeSession.watches == [true, false])
        #expect(workSession.watches == [true])
    }
    @Test func theWatchedMachineStopsReadingWhenTheTabGoes() async throws {
        let (home, session) = try await connected("home")
        let watch = SpadeWatch()
        let hold = watch.hold(home, on: true, among: [home])
        watch.release(hold)
        #expect(session.watches == [true, false])
        // Spade back on with Threads showing: a new runtime isn't told to read the bots again.
        home.spadeResume()
        #expect(session.watches == [true, false])
    }
    @Test func aMachineThatStopsShowingSpadeStopsReading() async throws {
        let (home, session) = try await connected("home")
        let watch = SpadeWatch()
        _ = watch.hold(home, on: true, among: [home])
        _ = watch.hold(nil, on: true, among: [])
        #expect(session.watches == [true, false])
    }
    @Test func anEarlierHoldEndingLateLeavesTheNewerWatchReading() async throws {
        let (home, session) = try await connected("home")
        let watch = SpadeWatch()
        let hidden = watch.hold(home, on: false, among: [home])
        _ = watch.hold(home, on: true, among: [home])
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
