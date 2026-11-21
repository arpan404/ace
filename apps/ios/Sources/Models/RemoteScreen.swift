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
    /// Watch only: a whole display captured without a sharing dialog, or a desktop that shares without input.
    let viewOnly: Bool?
    /// Why that desktop lets the person watch but not control (Linux on KDE and Hyprland); empty otherwise.
    let watchOnlyReason: String?
    /// A screen shared in the machine's dialog: the person's to control, never an agent's.
    let personOnly: Bool?
    /// One sentence while this app's video runs degraded on the processor; empty otherwise.
    var degraded: String? = nil
    var id: String { sessionId }
    var waiting: Bool { awaitingChoice == true }
    var controllable: Bool { awaitingChoice != true && viewOnly != true }
}
private struct ScreenSessionsReply: Decodable { let sessions: [ScreenSessionInfo] }
/// A screen request the daemon refused, with its code when it gave one.
private struct ScreenRefusal: LocalizedError {
    let message: String
    let code: String?
    var errorDescription: String? { message }
}
struct RemoteScreenPermissions: Decodable {
    let screenRecording: Bool
    let accessibility: Bool
    let platform: String?
    let requirements: [RemoteScreenRequirement]?
}
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

/// One screen request to the machine and its raw answer: `ClientModel.service` on the phone,
/// a stand-in in tests.
typealias ScreenAsk = @MainActor (_ payload: [String: Any], _ timeout: Duration) async throws -> ServiceValue

extension ClientModel {
    var screenAsk: ScreenAsk {
        { [weak self] payload, timeout in
            guard let self else { throw CancellationError() }
            return try await self.service(payload, as: ServiceValue.self, timeout: timeout)
        }
    }
}

/// What the Computer use page shows above its rows: the read under way, the read that failed
/// (with Try again), or the machine's state.
enum RemoteScreenPage: Equatable {
    case reading
    case failed(String)
    case shown
}

@MainActor @Observable final class RemoteScreen {
    private(set) var status: RemoteScreenStatus?
    /// A read of the machine's computer use is under way. It starts true: the page's first read
    /// begins as it appears.
    private(set) var reading = true
    /// Which read is the latest; an older one that ends late doesn't end the newer one's wait.
    private var generation = 0
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
    /// The page as the reads left it. Never a wait with nothing under way: a read that was
    /// cancelled or never started says so, with Try again.
    var page: RemoteScreenPage {
        if status != nil { return .shown }
        if let problem { return .failed(problem) }
        return reading ? .reading : .failed("Computer use hasn't loaded.")
    }
    func refresh(_ model: ClientModel) async { await load(model.screenAsk) }
    /// Reads whether computer use is on and its permissions, then the apps in use. The page
    /// shows the first answer as it comes: the permission check can take seconds on a Mac.
    func load(_ ask: ScreenAsk) async {
        generation += 1
        let mine = generation
        reading = true
        defer { if generation == mine { reading = false } }
        do {
            status = try await request(ask, ["op": "status"])
            problem = nil
            states = try await request(ask, ["op": "sessions"])
            sessions = try await shaped(ask)
            owned = owned.filter { state($0)?.controller == "human" }
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
        // A background window takes the input but can't confirm its effect; the live picture
        // shows what it did, and the person keeps control.
        catch let refused as ScreenRefusal where refused.code == "delivery_unconfirmed" { return true }
        catch { owned.remove(id); problem = error.localizedDescription; return false }
    }
    func watch(_ model: ClientModel, id: String) async {
        guard model.connection == "ready", let session = model.browserSession else { return }
        live.open(sessionId: id, session: session)
        do {
            let _: ServiceValue = try await request(model, ["op": "subscribe", "sessionId": id])
            // Until a viewer asks for video the Mac sends only stills, and a live view draws none:
            // without this the picture stays black. The daemon holds the bit rate to the link.
            let _: ServiceValue = try await request(model, ["op": "stream.configure", "sessionId": id,
                "settings": ["codec": "h264", "maxWidth": 2560, "maxHeight": 2560, "fps": 60, "bitrate": 6_000_000]])
        } catch { live.close(); if !Task.isCancelled { problem = error.localizedDescription } }
    }
    func unwatch(_ model: ClientModel, id: String) {
        live.close()
        model.action(["type": "native.screen.unwatch", "sessionId": id])
        if owned.remove(id) != nil { model.action(["type": "native.screen.release", "sessionId": id]) }
    }
    /// The machine went away: nothing is read until it is back.
    func disconnected() {
        live.close(); owned.removeAll()
        generation += 1
        reading = false
    }
    private func shaped(_ ask: ScreenAsk) async throws -> [ScreenSessionInfo] {
        let reply = try await ask(["type": "screen.sessions"], .seconds(30)).decode(DeviceServiceReply<ScreenSessionsReply>.self)
        guard reply.ok, let data = reply.data else { throw ServiceFailure(message: reply.error?.message ?? "Screen request failed") }
        return data.sessions
    }
    private func request<T: Decodable>(_ model: ClientModel, _ operation: [String: Any], timeout: Duration = .seconds(30)) async throws -> T {
        try await request(model.screenAsk, operation, timeout: timeout)
    }
    private func request<T: Decodable>(_ ask: ScreenAsk, _ operation: [String: Any], timeout: Duration = .seconds(30)) async throws -> T {
        let reply = try await ask(["type": "screen.request", "operation": operation], timeout).decode(DeviceServiceReply<T>.self)
        guard reply.ok else { throw ScreenRefusal(message: reply.error?.message ?? "Screen request failed", code: reply.error?.code) }
        if let data = reply.data { return data }
        return try ServiceValue.null.decode(T.self)
    }
}
