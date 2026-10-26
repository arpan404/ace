import Foundation
import Testing
@testable import Ace

/// Settings that belong to one machine stay with that machine, and the phone's own choices
/// (per-machine alerts, app lock) survive a relaunch. Only the JavaScriptCore boundary is faked.
@Suite @MainActor struct SettingsPersistenceTests {
    @Test func turningOneMachineOffStopsOnlyItsDeliveryAndIsRememberedAfterRelaunch() async throws {
        let defaults = try suite()
        let (coordinator, sessions) = try await twoMachines(defaults)
        coordinator.setMachine("studio", enabled: false)
        #expect(coordinator.delivering("mac"))
        #expect(!coordinator.delivering("studio"))
        // Each machine's bridge is told its own state.
        #expect(sessions.session("studio")?.actions("notifications.sync").last?["enabled"] as? Bool == false)
        #expect(sessions.session("mac")?.actions("notifications.sync").last?["enabled"] as? Bool == true)

        let (relaunched, later) = try await twoMachines(defaults)
        #expect(relaunched.muted == ["studio"])
        #expect(later.session("studio")?.actions("notifications.sync").last?["enabled"] as? Bool == false)
        #expect(later.session("mac")?.actions("notifications.sync").last?["enabled"] as? Bool == true)
        relaunched.setMachine("studio", enabled: true)
        #expect(relaunched.delivering("studio"))
    }

    @Test func aMutedMachinesAlertIsNotPostedButTheOtherMachinesIs() async throws {
        let center = RecordingCenter()
        let (coordinator, sessions) = try await twoMachines(try suite(), center: center)
        coordinator.setMachine("studio", enabled: false)
        sessions.session("studio")?.patch(alert("s:1"))
        sessions.session("mac")?.patch(alert("m:1"))
        for _ in 0..<200 where center.posted.isEmpty { await Task.yield() }
        #expect(center.posted == [AlertContent.requestId("m:1", hostId: "mac")])
    }

    @Test func quietHoursAreReadAndSavedPerMachine() async throws {
        let (coordinator, sessions) = try await twoMachines(try suite())
        sessions.session("studio")?.patch(#"{"type":"notifications.config","preferences":{"quietHours":{"timeZone":"UTC","startMinute":1320,"endMinute":420},"includePreview":false}}"#)
        sessions.session("mac")?.patch(#"{"type":"notifications.config","preferences":{"includePreview":false}}"#)
        await settle()
        #expect(coordinator.preferences(for: "studio").quietHours?.startMinute == 1320)
        #expect(coordinator.preferences(for: "mac").quietHours == nil)

        var mac = coordinator.preferences(for: "mac")
        mac.quietHours = QuietHours(timeZone: "UTC", startMinute: 60, endMinute: 120)
        coordinator.save(mac, for: "mac")
        #expect(sessions.session("mac")?.actions("notifications.preferences").count == 1)
        #expect(sessions.session("studio")?.actions("notifications.preferences").isEmpty == true)
        // The other machine keeps what it reported.
        #expect(coordinator.preferences(for: "studio").quietHours?.startMinute == 1320)
    }

    @Test func aThreadSnoozeIsSentToItsOwnMachine() async throws {
        let (coordinator, sessions) = try await twoMachines(try suite())
        coordinator.snooze("t1", until: 9_000, hostId: "studio")
        #expect(sessions.session("studio")?.actions("notifications.snooze").first?["threadId"] as? String == "t1")
        #expect(sessions.session("mac")?.actions("notifications.snooze").isEmpty == true)
        #expect(coordinator.snoozes(for: "studio")["t1"] == 9_000)
        #expect(coordinator.snoozes(for: "mac").isEmpty)
    }

    @Test func appLockChoicesSurviveARelaunchAndTurningItOffNeedsTheOwner() async throws {
        let defaults = try suite()
        let refusing = AppLock(enabled: true, now: { Date(timeIntervalSince1970: 0) }, authenticator: Fixed(.failed), defaults: defaults)
        #expect(await refusing.setEnabled(false) == true)
        refusing.setTimeout(300)
        refusing.setTimeout(42) // Not offered: ignored.
        #expect(refusing.timeout == 300)

        let owner = AppLock(enabled: true, now: { Date(timeIntervalSince1970: 0) }, authenticator: Fixed(.success), defaults: defaults)
        #expect(owner.timeout == 300)
        #expect(await owner.setEnabled(false) == false)
        #expect(!owner.locked)

        // Pairing again doesn't override the person's choice.
        let relaunched = AppLock(enabled: true, now: { Date(timeIntervalSince1970: 0) }, authenticator: Fixed(.success), defaults: defaults)
        relaunched.enable()
        #expect(!relaunched.enabled)
        #expect(!relaunched.locked)
    }

    @Test func theLockReturnsAfterTheChosenTimeInTheBackground() async throws {
        var clock = Date(timeIntervalSince1970: 0)
        let lock = AppLock(enabled: true, now: { clock }, authenticator: Fixed(.success), defaults: try suite())
        await lock.unlock()
        lock.setTimeout(0)
        lock.didEnterBackground()
        clock = clock.addingTimeInterval(1)
        lock.didBecomeActive()
        #expect(lock.locked)
    }

    @Test func diagnosticsCarryStateButNoAddressPinOrDeviceId() async throws {
        let inbox = MachineInbox(defaults: try suite(), now: { 0 })
        let client = ClientModel(now: { 0 })
        client.connection = "offline"
        inbox.attach("host-1", name: "studio", client: client)
        let entry = try JSONDecoder().decode(MachineEntry.self, from: Data(#"""
        {"hostId":"host-1","displayName":"studio","icon":null,"deviceId":"device-secret-id",
         "target":{"kind":"lan","url":"wss://192.168.1.20:9443","fingerprint":"sha256/PINPINPIN"}}
        """#.utf8))
        let report = DiagnosticsReport.collect(app: .init(version: "1.0", build: "7", system: "iOS", device: "iPhone"),
                                               inbox: inbox, entries: [entry], notifications: nil, lock: nil,
                                               now: Date(timeIntervalSince1970: 0)).json
        #expect(report.contains(#""connection" : "offline""#))
        #expect(report.contains(#""access" : "lan""#))
        for secret in ["device-secret-id", "192.168.1.20", "PINPINPIN", "wss://"] { #expect(!report.contains(secret)) }
    }

    // MARK: Helpers

    /// Patches reach the model on a main-actor task, as they do from the VM's thread.
    private func settle() async { for _ in 0..<50 { await Task.yield() } }
    private func suite() throws -> UserDefaults { try #require(UserDefaults(suiteName: "ace.tests.\(UUID().uuidString)")) }
    private func twoMachines(_ defaults: UserDefaults, center: RecordingCenter = RecordingCenter()) async throws -> (NotificationCoordinator, Sessions) {
        let sessions = Sessions()
        let coordinator = NotificationCoordinator(center: center, authorizer: Allowing(), defaults: defaults, now: { 0 },
                                                  sleep: { _ in await Task.yield() }, makeId: { "id" }, connectInBackground: { _ in [] })
        await coordinator.setEnabled(true)
        for host in ["mac", "studio"] {
            let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: { target, _, receive, _ in sessions.make(target.hostId, receive) })
            let target = ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:1")), hostId: host, deviceId: "device",
                                          pin: nil, credential: { "{}" })
            await coordinator.attach(model, target: target)
            await model.connect(target: target, directory: FileManager.default.temporaryDirectory)
        }
        coordinator.sync()
        return (coordinator, sessions)
    }
    private func alert(_ id: String) -> String {
        #"{"type":"notifications.alert","notification":{"id":"\#(id)","threadId":"t","title":"T","status":"done","backgroundCount":0,"actions":[]}}"#
    }
}

private struct Fixed: Authenticator {
    let outcome: AuthenticationOutcome
    init(_ outcome: AuthenticationOutcome) { self.outcome = outcome }
    func authenticate(reason: String) async -> AuthenticationOutcome { outcome }
}
private struct Allowing: NotificationAuthorizer {
    func status() async -> NotificationCoordinator.Permission { .allowed }
    func request() async -> Bool { true }
}
private final class RecordingCenter: NotificationCenterPort, @unchecked Sendable {
    var posted: [String] = []
    func post(_ content: AlertContent) async { posted.append(content.identifier) }
    func withdraw(_ identifiers: [String]) {}
}
@MainActor private final class Sessions {
    var byHost: [String: FakeSession] = [:]
    func make(_ host: String, _ receive: @escaping @Sendable (Data) -> Void) -> any ClientSession {
        let session = FakeSession(receive: receive)
        byHost[host] = session
        return session
    }
    func session(_ host: String) -> FakeSession? { byHost[host] }
}
private final class FakeSession: ClientSession, @unchecked Sendable {
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
