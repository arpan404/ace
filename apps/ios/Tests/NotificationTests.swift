import Foundation
import Testing
@testable import Ace

@Suite @MainActor struct NotificationTests {
    @Test func anAlertSeenLiveAndAgainInCatchUpIsPostedOnceUnderItsStableId() async throws {
        let center = FakeCenter()
        let store = LedgerStore(scope: "host", defaults: try defaults())
        let notifier = LocalNotifier(center: center)
        notifier.bind(store)
        await notifier.receive(alert("n:1"))
        await notifier.catchUp(cursor: 3, entries: [alert("n:1"), alert("n:2")], retracted: [])
        #expect(center.posted.map(\.identifier) == ["n:1", "n:2"])
        #expect(notifier.ledger.cursor == 3)
        // After a relaunch the same catch-up page alerts nothing new.
        let relaunched = LocalNotifier(center: center)
        relaunched.bind(store)
        await relaunched.catchUp(cursor: 3, entries: [alert("n:1"), alert("n:2")], retracted: [])
        #expect(center.posted.count == 2)
    }

    @Test func catchUpWithdrawsAnAlertTheThreadNoLongerSupports() async throws {
        let center = FakeCenter()
        let notifier = LocalNotifier(center: center)
        notifier.bind(LedgerStore(scope: "host", defaults: try defaults()))
        await notifier.receive(alert("n:1", status: "done"))
        await notifier.catchUp(cursor: 1, entries: [], retracted: ["n:1"])
        #expect(center.withdrawn == ["n:1"])
    }

    @Test func thePhonesDeliveryChoiceDecidesWhetherAndHowAnAlertIsPosted() async throws {
        let center = FakeCenter()
        let notifier = LocalNotifier(center: center)
        notifier.bind(LedgerStore(scope: "host", defaults: try defaults()))
        var off = alert("n:1", status: "failed")
        off.delivery = .init(post: false, interrupt: false, banner: false)
        var quiet = alert("n:2", status: "needs_you")
        quiet.delivery = .init(post: true, interrupt: false, banner: false)
        await notifier.receive(off)
        await notifier.catchUp(cursor: 2, entries: [off, quiet], retracted: [])
        #expect(center.posted.map(\.identifier) == ["n:2"])
        #expect(center.posted.first?.level == .passive)
        #expect(center.posted.first?.banner == false)
        // An alert from a runtime that says nothing about delivery shows as before.
        #expect(AlertContent(alert("n:3", status: "needs_you")).level == .timeSensitive)
        #expect(AlertContent(alert("n:3")).banner)
    }

    @Test func onlyTheDaemonsFixedApproveDenyPairGetsButtonsAndUnknownStatusesNeverSayDone() {
        let approval = AlertContent(alert("n:1", status: "needs_you", actions: true))
        #expect(approval.category == AlertContent.approvalCategory)
        #expect((approval.approveOption, approval.denyOption) == ("allow", "deny"))
        #expect(approval.level == .timeSensitive)
        #expect(AlertContent(alert("n:2", status: "needs_you")).category == AlertContent.threadCategory)
        #expect(AlertContent(alert("n:3", status: "something_new")).body == "New activity")
    }

    @Test func allowAnswersTheOfferedOptionThroughTheBridgeAndClearsTheAlertOnceConfirmed() async throws {
        let (coordinator, center, session) = try await connected()
        let response = Task {
            await coordinator.respond(action: NotificationActionID.approve, notificationId: "n:7", info: approvalInfo)
        }
        let resolve = try await session.waitFor("notifications.resolve")
        #expect(resolve["optionId"] as? String == "allow")
        #expect(resolve["interactionId"] as? String == "push")
        #expect(resolve["threadId"] as? String == "thread")
        session.patch(#"{"type":"notifications.action","id":"tap-1","outcome":"confirmed"}"#)
        await response.value
        #expect(center.withdrawn == ["n:7"])
        #expect(center.posted.isEmpty)
    }

    @Test func anActionThatCannotReachTheMachineSendsNothingAndAsksToOpenAce() async throws {
        let center = FakeCenter()
        let sessions = Sessions()
        let coordinator = NotificationCoordinator(center: center, authorizer: FakeAuthorizer(), defaults: try defaults(), now: { 0 },
                                                  sleep: fastSleep, makeId: { "tap-1" }, connectInBackground: { _ in [] })
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        await coordinator.attach(model, target: try target())
        await model.connect(target: try target(), directory: URL(fileURLWithPath: "/unused"))
        await coordinator.respond(action: NotificationActionID.deny, notificationId: "n:7", info: approvalInfo)
        #expect(sessions.values.first?.actions("notifications.resolve").isEmpty == true)
        #expect(center.posted.map(\.body) == ["Couldn't reach your machine. Open ace to answer."])
        #expect(center.posted.first?.category == AlertContent.threadCategory)
        await model.disconnectAndWait()
    }

    @Test func tappingAnAlertOpensItsThread() async throws {
        let (coordinator, _, _) = try await connected()
        await coordinator.respond(action: "com.apple.UNNotificationDefaultActionIdentifier", notificationId: "n:7", info: approvalInfo)
        #expect(coordinator.model?.deepLink == "thread")
    }

    @Test func eachMachineKeepsItsOwnCatchUpAndAnAnswerGoesToTheMachineThatRaisedTheAlert() async throws {
        let center = FakeCenter()
        let sessions = Sessions()
        let coordinator = NotificationCoordinator(center: center, authorizer: FakeAuthorizer(), defaults: try defaults(), now: { 0 },
                                                  sleep: fastSleep, makeId: { "tap-1" }, connectInBackground: { _ in [] })
        await coordinator.setEnabled(true)
        for host in ["studio", "laptop"] {
            let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
            await coordinator.attach(model, target: try target(host))
            await model.connect(target: try target(host), directory: URL(fileURLWithPath: "/unused"))
        }
        let (studio, laptop) = (sessions.values[0], sessions.values[1])
        for session in [studio, laptop] { session.patch(#"{"type":"connection","state":"ready"}"#) }
        // The same alert id from two daemons is two alerts, each tagged with its machine.
        let alert = #"{"id":"n:1","threadId":"thread","title":"Fix","status":"needs_you","interactionId":"push","backgroundCount":0,"actions":[{"action":"approve","optionId":"allow"},{"action":"deny","optionId":"deny"}]}"#
        laptop.patch(#"{"type":"notifications.feed","cursor":9,"entries":[\#(alert)],"retracted":[]}"#)
        studio.patch(#"{"type":"notifications.alert","notification":\#(alert)}"#)
        for _ in 0..<50 { await Task.yield() }
        #expect(center.posted.map(\.hostId) == ["laptop", "studio"])
        // Only the laptop's catch-up cursor moved: the next sync tells each machine its own.
        coordinator.sync()
        #expect(laptop.actions("notifications.sync").last?["cursor"] as? Int == 9)
        #expect(studio.actions("notifications.sync").last?["cursor"] as? Int == 0)

        var info = approvalInfo
        info[NotificationKeys.hostId] = "laptop"
        let response = Task { await coordinator.respond(action: NotificationActionID.approve, notificationId: "n:1", info: info) }
        _ = try await laptop.waitFor("notifications.resolve")
        #expect(studio.actions("notifications.resolve").isEmpty)
        laptop.patch(#"{"type":"notifications.action","id":"tap-1","outcome":"confirmed"}"#)
        await response.value
        #expect(center.withdrawn == ["n:1"])
    }

    @Test func theSameAlertIdFromTwoMachinesShowsTwiceAndRetractingOneLeavesTheOther() async throws {
        let center = FakeCenter()
        let store = try defaults()
        let studio = LocalNotifier(center: center, hostId: "studio")
        studio.bind(LedgerStore(scope: "studio", defaults: store))
        let laptop = LocalNotifier(center: center, hostId: "laptop")
        laptop.bind(LedgerStore(scope: "laptop", defaults: store))
        await studio.receive(alert("n:1"))
        await laptop.receive(alert("n:1"))
        #expect(Set(center.delivered.values.compactMap(\.hostId)) == ["studio", "laptop"])
        await laptop.catchUp(cursor: 1, entries: [], retracted: ["n:1"])
        #expect(center.delivered.values.map(\.hostId) == ["studio"])
    }

    @Test func aRetractionAlsoWithdrawsTheBareIdAnOlderBuildPosted() async throws {
        let center = FakeCenter()
        await center.post(AlertContent(alert("n:1")))
        let notifier = LocalNotifier(center: center, hostId: "studio")
        notifier.bind(LedgerStore(scope: "studio", defaults: try defaults()))
        await notifier.catchUp(cursor: 1, entries: [], retracted: ["n:1"])
        #expect(center.delivered.isEmpty)
    }

    // MARK: Support

    private let approvalInfo = [NotificationKeys.threadId: "thread", NotificationKeys.interactionId: "push",
                                NotificationKeys.approve: "allow", NotificationKeys.deny: "deny"]
    private func connected() async throws -> (NotificationCoordinator, FakeCenter, Session) {
        let center = FakeCenter()
        let sessions = Sessions()
        let coordinator = NotificationCoordinator(center: center, authorizer: FakeAuthorizer(), defaults: try defaults(), now: { 0 },
                                                  sleep: fastSleep, makeId: { "tap-1" }, connectInBackground: { _ in [] })
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        await coordinator.attach(model, target: try target())
        await model.connect(target: try target(), directory: URL(fileURLWithPath: "/unused"))
        let session = try #require(sessions.values.first)
        session.patch(#"{"type":"connection","state":"ready"}"#)
        for _ in 0..<20 { await Task.yield() }
        #expect(model.connection == "ready")
        return (coordinator, center, session)
    }
    private func defaults() throws -> UserDefaults { try #require(UserDefaults(suiteName: "ace.tests.\(UUID().uuidString)")) }
    private func target(_ host: String = "host") throws -> ConnectionTarget {
        ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:9841")), hostId: host, deviceId: "phone", pin: nil, credential: { "{}" })
    }
    private func alert(_ id: String, status: String = "done", actions: Bool = false) -> AlertNotification {
        AlertNotification(id: id, threadId: "thread", title: "Fix the flaky queue test", status: status,
                          interactionId: actions ? "push" : nil, backgroundCount: 0,
                          actions: actions ? [.init(action: "approve", optionId: "allow"), .init(action: "deny", optionId: "deny")] : [],
                          preview: nil, message: nil)
    }
}

/// Polling steps pass at once; long deadlines never fire during a test.
private let fastSleep: @Sendable (Duration) async -> Void = { duration in
    if duration < .seconds(1) { await Task.yield() } else { try? await Task.sleep(for: .seconds(60)) }
}
private final class FakeCenter: NotificationCenterPort, @unchecked Sendable {
    var posted: [AlertContent] = []
    var withdrawn: [String] = []
    /// What Notification Center shows: a post replaces any with the same identifier.
    var delivered: [String: AlertContent] = [:]
    func post(_ content: AlertContent) async { posted.append(content); delivered[content.identifier] = content }
    func withdraw(_ identifiers: [String]) {
        withdrawn.append(contentsOf: identifiers)
        for id in identifiers { delivered.removeValue(forKey: id) }
    }
}
private struct FakeAuthorizer: NotificationAuthorizer {
    func status() async -> NotificationCoordinator.Permission { .allowed }
    func request() async -> Bool { true }
}
@MainActor private final class Sessions {
    var values: [Session] = []
    func make(_ target: ConnectionTarget, _ storage: URL, _ receive: @escaping @Sendable (Data) -> Void,
              _ fail: @escaping @Sendable (String) -> Void) -> any ClientSession {
        let session = Session(receive: receive)
        values.append(session)
        return session
    }
}
/// Only the JavaScriptCore boundary is substituted: actions out, patches in.
private final class Session: ClientSession, @unchecked Sendable {
    private let receive: @Sendable (Data) -> Void
    private let lock = NSLock()
    private var invoked: [[String: Any]] = []
    init(receive: @escaping @Sendable (Data) -> Void) { self.receive = receive }
    func start(itemLimit: Int) {}
    func invoke(_ name: String, json: String) {
        guard let value = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return }
        lock.withLock { invoked.append(value) }
    }
    func acknowledge(accepted: Bool) {}
    func stop(completion: @escaping @Sendable () -> Void) { completion() }
    func patch(_ json: String) { receive(Data("[\(json)]".utf8)) }
    func actions(_ type: String) -> [[String: Any]] { lock.withLock { invoked.filter { $0["type"] as? String == type } } }
    @MainActor func waitFor(_ type: String) async throws -> [String: Any] {
        for _ in 0..<1000 {
            if let found = actions(type).first { return found }
            await Task.yield()
        }
        throw CancellationError()
    }
}
