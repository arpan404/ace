import Foundation
import Observation

struct RemoteScreenTarget: Codable {
    let kind: String
    let bundleId: String?
    let windowId: Int?
    let displayId: Int?
    let bundleIds: [String]?
}
struct RemoteScreenState: Decodable, Identifiable {
    struct Holder: Decodable { let threadId: String; let agentId: String }
    let sessionId: String
    let lifecycle: String
    let controller: String
    let mode: String?
    let secureInputAllowed: Bool?
    let target: RemoteScreenTarget
    let holder: Holder?
    let error: String?
    var id: String { sessionId }
    var title: String { target.bundleId ?? "Display \(target.displayId ?? 0)" }
}
/// One app as computer use lists it, in the web's words (`bridge/screen-view.ts`).
struct ScreenSessionInfo: Decodable, Identifiable, Hashable {
    let sessionId: String
    let app: String
    let detail: String
    /// "Claude is in control", "You're in control", "Starting".
    let status: String
    let mode: String
    let foreground: Bool
    let capturing: Bool
    let controller: String
    let lifecycle: String
    let error: String
    let stoppable: Bool
    let secureInputAllowed: Bool
    /// The machine's sharing dialog waits for the person there (Linux on Wayland).
    let awaitingChoice: Bool?
    /// A whole display captured without a sharing dialog: watch only.
    let viewOnly: Bool?
    /// A screen shared in the machine's dialog: the person's to control, never an agent's.
    let personOnly: Bool?
    var id: String { sessionId }
    var waiting: Bool { awaitingChoice == true }
    var controllable: Bool { awaitingChoice != true && viewOnly != true }
}
private struct ScreenSessionsReply: Decodable { let sessions: [ScreenSessionInfo] }
struct RemoteScreenPermissions: Decodable { let screenRecording: Bool; let accessibility: Bool }
struct RemoteScreenStatus: Decodable { let enabled: Bool; let permissions: RemoteScreenPermissions; let sessions: Int }
struct RemoteScreenInventory: Decodable {
    struct Window: Decodable, Identifiable {
        let windowId: Int; let bundleId: String; let title: String
        var id: Int { windowId }
        var target: RemoteScreenTarget { .init(kind: "window", bundleId: bundleId, windowId: windowId, displayId: nil, bundleIds: nil) }
    }
    /// Where the machine's own sharing dialog picks what is shared, it lists nothing.
    struct Chooser: Decodable { let windows: Bool; let displays: Bool }
    let windows: [Window]
    let chooser: Chooser?
}

@MainActor @Observable final class RemoteScreen {
    private(set) var status: RemoteScreenStatus?
    private(set) var states: [RemoteScreenState] = []
    private(set) var sessions: [ScreenSessionInfo] = []
    private(set) var windows: [RemoteScreenInventory.Window] = []
    /// The machine's sharing dialog picks what is shared (Linux on Wayland).
    private(set) var dialogPicks = false
    /// The person cancelled a wait in the sharing dialog: its ending needs no sentence.
    private var cancellingChoice = false
    private(set) var problem: String?
    private(set) var busy = false
    private var owned: Set<String> = []
    private var previous: [String: RemoteScreenState.Holder] = [:]
    let live = ScreenLiveModel()
    func state(_ id: String) -> RemoteScreenState? { states.first { $0.id == id } }
    func session(_ id: String) -> ScreenSessionInfo? { sessions.first { $0.id == id } }
    func controls(_ id: String) -> Bool { owned.contains(id) && state(id)?.controller == "human" }
    func previousHolder(_ id: String) -> RemoteScreenState.Holder? { previous[id] }
    func refresh(_ model: ClientModel) async {
        do {
            status = try await request(model, ["op": "status"])
            states = try await request(model, ["op": "sessions"])
            sessions = try await shaped(model)
            owned = owned.filter { state($0)?.controller == "human" }
            problem = nil
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
    func targets(_ model: ClientModel) async {
        do {
            let inventory: RemoteScreenInventory = try await request(model, ["op": "targets"])
            windows = inventory.windows; dialogPicks = inventory.chooser != nil; problem = nil
        }
        catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
    func perform(_ model: ClientModel, _ operation: [String: Any]) async -> Bool {
        guard model.connection == "ready", model.canOperate, !busy else { return false }
        busy = true; problem = nil
        defer { busy = false }
        do { let _: ServiceValue = try await request(model, operation); await refresh(model); return true }
        catch { if !Task.isCancelled { problem = error.localizedDescription }; return false }
    }
    func start(_ model: ClientModel, target: RemoteScreenTarget, threadId: String?) async -> String? {
        guard model.connection == "ready", model.canOperate, !busy else { return nil }
        busy = true; problem = nil
        defer { busy = false }
        do {
            let encoded = try JSONEncoder().encode(target)
            var operation: [String: Any] = ["op": "start", "target": try JSONSerialization.jsonObject(with: encoded), "fps": 30]
            if let threadId { operation["threadId"] = threadId }
            let created: RemoteScreenState = try await request(model, operation)
            await refresh(model)
            return created.id
        } catch { if !Task.isCancelled { problem = error.localizedDescription }; return nil }
    }
    /// Shares what the person picks in the machine's own sharing dialog. It waits up to two
    /// minutes for them there, so it holds nothing else up; the list shows the wait meanwhile.
    func startChoice(_ model: ClientModel, threadId: String?) async -> String? {
        guard model.connection == "ready", model.canOperate else { return nil }
        problem = nil; cancellingChoice = false
        let shown = Task { try? await Task.sleep(for: .milliseconds(600)); await refresh(model) }
        defer { shown.cancel() }
        var operation: [String: Any] = ["op": "start", "target": ["kind": "chooser"], "fps": 30]
        if let threadId { operation["threadId"] = threadId }
        do {
            let created: RemoteScreenState = try await request(model, operation, timeout: .seconds(150))
            await refresh(model)
            return created.id
        } catch {
            let message = error.localizedDescription
            await refresh(model)
            if !Task.isCancelled, !cancellingChoice { problem = message }
            return nil
        }
    }
    /// Ends a wait in the machine's sharing dialog; the dialog there closes.
    func cancelChoice(_ model: ClientModel, id: String) async {
        cancellingChoice = true
        _ = await perform(model, ["op": "stop", "sessionId": id])
    }
    func takeControl(_ model: ClientModel, id: String) async {
        if let holder = state(id)?.holder { previous[id] = holder }
        if await perform(model, ["op": "controller", "sessionId": id, "controller": "human"]) { owned.insert(id) }
    }
    func release(_ model: ClientModel, id: String) async {
        guard owned.remove(id) != nil else { return }
        do { let _: ServiceValue = try await request(model, ["op": "controller", "sessionId": id, "controller": "none"]); await refresh(model) }
        catch { problem = error.localizedDescription }
    }
    func input(_ model: ClientModel, id: String, _ input: [String: Any]) async -> Bool {
        guard model.connection == "ready", model.canOperate, controls(id) else { return false }
        do { let _: ServiceValue = try await request(model, ["op": "input", "sessionId": id, "input": input]); return true }
        catch { owned.remove(id); problem = error.localizedDescription; return false }
    }
    func watch(_ model: ClientModel, id: String) async {
        guard model.connection == "ready", let session = model.browserSession else { return }
        live.open(sessionId: id, session: session)
        do { let _: ServiceValue = try await request(model, ["op": "subscribe", "sessionId": id]) }
        catch { live.close(); if !Task.isCancelled { problem = error.localizedDescription } }
    }
    func unwatch(_ model: ClientModel, id: String) {
        live.close()
        model.action(["type": "native.screen.unwatch", "sessionId": id])
        if owned.remove(id) != nil { model.action(["type": "native.screen.release", "sessionId": id]) }
    }
    func disconnected() { live.close(); owned.removeAll() }
    private func shaped(_ model: ClientModel) async throws -> [ScreenSessionInfo] {
        let reply = try await model.service(["type": "screen.sessions"], as: DeviceServiceReply<ScreenSessionsReply>.self)
        guard reply.ok, let data = reply.data else { throw ServiceFailure(message: reply.error?.message ?? "Screen request failed") }
        return data.sessions
    }
    private func request<T: Decodable>(_ model: ClientModel, _ operation: [String: Any], timeout: Duration = .seconds(30)) async throws -> T {
        let reply = try await model.service(["type": "screen.request", "operation": operation], as: DeviceServiceReply<T>.self, timeout: timeout)
        guard reply.ok else { throw ServiceFailure(message: reply.error?.message ?? "Screen request failed") }
        if let data = reply.data { return data }
        return try ServiceValue.null.decode(T.self)
    }
}
