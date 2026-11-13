import Foundation
import Testing
import UserNotifications
@testable import Ace

/// Remote push (ADR 0106), the app's side: the push address each paired machine's
/// `notifications.sync` carries, asking iOS for a token, and alerts a push already showed.
@Suite @MainActor struct PushAddressTests {
    // MARK: Each machine's sync

    @Test func eachMachinesSyncCarriesThePhonesTokenAndKeyOnceItHasOne() async throws {
        let (coordinator, session) = try await connectedMachine()
        session.patch(#"{"type":"notifications.connected"}"#)
        try await until("a sync") { !session.actions("notifications.sync").isEmpty }
        // No token yet (none granted, or no push entitlement): no push field at all.
        #expect(session.actions("notifications.sync").allSatisfy { $0["push"] == nil })

        let key = try PushVectors.load().key()
        coordinator.registeredForPush(PushRegistration(token: Data([0xAB, 0x01, 0xFF, 0x10]), environment: .sandbox, key: key))
        let push = try #require(session.actions("notifications.sync").last?["push"] as? [String: String])
        #expect(push == ["token": "ab01ff10", "environment": "sandbox",
                         "p256dh": "BJgWIHRa_Q9rPu5UxpgT9hiNnr9SCggZjnCl0pUl-WdB93mMZGOIemUfHCUiMOCJBBuqYkne7618ciEwif3gDjA",
                         "auth": "bbg67MC6t-SoSCRcJpScdg"])

        // A new token goes to the machine at once; the same token again sends nothing new.
        let before = session.actions("notifications.sync").count
        coordinator.registeredForPush(PushRegistration(token: Data([0xAB, 0x01, 0xFF, 0x10]), environment: .sandbox, key: key))
        #expect(session.actions("notifications.sync").count == before)
        coordinator.registeredForPush(PushRegistration(token: Data([0x01]), environment: .production, key: key))
        let next = try #require(session.actions("notifications.sync").last?["push"] as? [String: String])
        #expect(next["token"] == "01")
        #expect(next["environment"] == "production")
    }

    @Test func aMachineTurnedOffOnThisPhoneIsNotGivenThePushAddress() async throws {
        let (coordinator, session) = try await connectedMachine()
        coordinator.registeredForPush(PushRegistration(token: Data([0xAB]), environment: .sandbox, key: PushKey.generate()))
        coordinator.setMachine("host", enabled: false)
        #expect(session.actions("notifications.sync").last?["enabled"] as? Bool == false)
        #expect(session.actions("notifications.sync").last?["push"] == nil)
    }

    @Test func notificationPermissionAsksIOSForAPushToken() async throws {
        let coordinator = NotificationCoordinator(center: Center(), authorizer: Authorizer(), defaults: try defaults(), now: { 0 },
                                                  sleep: fastSleep, makeId: { "x" }, connectInBackground: { _ in [] })
        var asked = 0
        coordinator.requestPushToken = { asked += 1 }
        await coordinator.setEnabled(true)
        #expect(asked >= 1)
    }

    @Test func noPermissionNeverAsksForAPushToken() async throws {
        let coordinator = NotificationCoordinator(center: Center(), authorizer: Authorizer(allowed: false), defaults: try defaults(),
                                                  now: { 0 }, sleep: fastSleep, makeId: { "x" }, connectInBackground: { _ in [] })
        var asked = 0
        coordinator.requestPushToken = { asked += 1 }
        await coordinator.setEnabled(true)
        await coordinator.refreshPermission()
        #expect(asked == 0)
    }

    // MARK: Shown once

    @Test func anAlertAPushAlreadyShowedIsNotPostedAgainWhenTheSocketBringsIt() async throws {
        let shared = try defaults()
        let pushed = PushedAlerts(defaults: shared)
        let vectors = try PushVectors.load()
        // The extension showed the push for n:42 on studio while the app was closed.
        _ = try #require(PushAlert.rewritten(try vectors.push("done").content, key: try vectors.key(), pushed: pushed))
        let center = Center()
        let (coordinator, session) = try await connectedMachine(host: "studio", center: center, pushed: pushed)
        _ = coordinator
        session.patch(#"{"type":"notifications.alert","notification":{"id":"n:42","threadId":"t-docs","title":"Write the README","status":"done","backgroundCount":0,"actions":[],"preview":"Added a build section"}}"#)
        session.patch(#"{"type":"notifications.alert","notification":{"id":"n:50","threadId":"t-other","title":"Other","status":"failed","backgroundCount":0,"actions":[]}}"#)
        try await until("the other alert posts") { !center.posted.isEmpty }
        for _ in 0..<20 { await Task.yield() }
        #expect(center.posted.map(\.title) == ["Other"])
    }

    // MARK: Helpers

    private func connectedMachine(host: String = "host", center: Center = Center(),
                                  pushed: PushedAlerts = PushedAlerts(defaults: nil)) async throws -> (NotificationCoordinator, Session) {
        let sessions = Sessions()
        let coordinator = NotificationCoordinator(center: center, authorizer: Authorizer(), defaults: try defaults(), now: { 0 },
                                                  sleep: fastSleep, makeId: { "x" }, connectInBackground: { _ in [] }, pushed: pushed)
        await coordinator.setEnabled(true)
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        let target = ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:9841")), hostId: host, deviceId: "phone",
                                      pin: nil, credential: { "{}" })
        await coordinator.attach(model, target: target)
        await model.connect(target: target, directory: URL(fileURLWithPath: "/unused"))
        let session = try #require(sessions.values.first)
        session.patch(#"{"type":"connection","state":"ready"}"#)
        try await until("the connection is ready") { model.connection == "ready" }
        return (coordinator, session)
    }
    private func defaults() throws -> UserDefaults { try #require(UserDefaults(suiteName: "ace.tests.\(UUID().uuidString)")) }
}

private final class Center: NotificationCenterPort, @unchecked Sendable {
    private let lock = NSLock()
    private var posts: [AlertContent] = []
    var posted: [AlertContent] { lock.withLock { posts } }
    func post(_ content: AlertContent) async { lock.withLock { posts.append(content) } }
    func withdraw(_ identifiers: [String]) {}
    func withdrawPushed(standingFor thread: String, except alert: String) {}
}
private struct Authorizer: NotificationAuthorizer {
    var allowed = true
    func status() async -> NotificationCoordinator.Permission { allowed ? .allowed : .denied }
    func request() async -> Bool { allowed }
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
}
@MainActor private func until(_ label: String, seconds: Int = 10, _ condition: () -> Bool) async throws {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(seconds))
    while !condition() {
        if clock.now >= deadline { Issue.record("Timed out waiting for \(label)"); return }
        try await Task.sleep(for: .milliseconds(5))
    }
}
private let fastSleep: @Sendable (Duration) async -> Void = { duration in
    if duration < .seconds(1) { await Task.yield() } else { try? await Task.sleep(for: .seconds(60)) }
}
