import CoreGraphics
import Foundation
import Observation

/// A refusal or failure as a person reads it (`@ace/ui-core/devices`): `permission` names a
/// macOS permission the machine's screen helper lacks.
struct DeviceProblem: Codable, Sendable, Equatable {
    let message: String
    let hint: String?
    var permission: String? = nil
    /// The daemon's error code, when it gave one (`delivery_unconfirmed`, `target_gone`, …).
    var code: String? = nil
    /// "Message. Hint." as one sentence pair.
    var text: String { [message, hint].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ") }
}
struct DeviceServiceReply<T: Decodable>: Decodable {
    let ok: Bool
    let data: T?
    let error: DeviceProblem?
}

/// One device as the Devices screen lists it (`bridge/devices-view.ts`).
struct DeviceTile: Codable, Sendable, Equatable, Identifiable, Hashable {
    let id: String
    let name: String
    let platform: String
    let kind: String
    /// "iOS 18.4 · Live".
    let detail: String
    let running: Bool
    let live: Bool
    /// "Claude is using it"; empty while nobody is.
    let control: String
}

/// The drawn hardware around a device's screen, in fractions of the screen's width.
struct DeviceFrameGeometry: Codable, Sendable, Equatable {
    struct Edges: Codable, Sendable, Equatable { let top: Double; let right: Double; let bottom: Double; let left: Double }
    let bezel: Edges
    let screenRadius: Double
    let bodyRadius: Double
    /// The metal band at the body's edge, outside its black glass.
    let band: Double
    let homeButton: Bool
}

/// The open device: who controls it, its hardware and frame, and the agent's newest action.
struct DeviceScreenInfo: Codable, Sendable, Equatable {
    struct Control: Codable, Sendable, Equatable {
        struct Holder: Codable, Sendable, Equatable { let threadId: String; let agentId: String }
        let sentence: String
        /// `take`, `handBack`, `release` or empty.
        let action: String
        var holder: Holder? = nil
    }
    struct Button: Codable, Sendable, Equatable, Identifiable { let label: String; let key: String; var id: String { key } }
    struct Frames: Codable, Sendable, Equatable { let portrait: DeviceFrameGeometry; let landscape: DeviceFrameGeometry }
    struct Activity: Codable, Sendable, Equatable {
        let sequence: Int
        let caption: String
        let provider: String
        var x: Double? = nil
        var y: Double? = nil
    }
    let id: String
    let name: String
    let platform: String
    let kind: String
    let subtitle: String
    let `where`: String
    let live: Bool
    let running: Bool
    let busy: Bool
    let cleanupRequired: Bool
    let recording: Bool
    let interactive: Bool
    let control: Control
    let buttons: [Button]
    let frame: Frames
    /// The screen's size upright, in points, until its first picture says otherwise.
    let screen: Size
    /// The key of the device's real look (`devices.chrome`), drawn instead of `frame` once here.
    var chrome: String? = nil
    struct Size: Codable, Sendable, Equatable { let width: Double; let height: Double }
    let activity: Activity?
    let problem: DeviceProblem?
    let touch: String
    /// A foldable device's posture (`closed`, `partiallyOpen` or `open`); nil when it doesn't fold.
    var posture: String? = nil
    /// The picture already shows the device's own body (a Simulator window): no frame around it.
    var framed: Bool? = nil
}

/// A thread's Devices screen, whole, as the bridge shapes it.
struct DevicesView: Codable, Sendable, Equatable {
    struct Group: Codable, Sendable, Equatable, Identifiable { let label: String; let rows: [DeviceTile]; var id: String { label } }
    let connected: Bool
    let loading: Bool
    let enabled: Bool
    let offline: DeviceProblem?
    let running: [DeviceTile]
    let groups: [Group]
    let notes: [DeviceProblem]
    let toolsMissing: Bool
    let device: DeviceScreenInfo?
}

/// The open logs sheet's newest lines, filtered by the bridge with the web's rule.
struct DeviceLogs: Codable, Sendable, Equatable {
    struct Line: Codable, Sendable, Equatable { let text: String; let level: String }
    let deviceId: String
    let error: String
    let total: Int
    let matches: Int
    let dropped: Int
    let lines: [Line]
}

/// The UI tree agents read, flattened with each element's depth.
struct DeviceTree: Codable, Sendable, Equatable {
    struct Row: Codable, Sendable, Equatable, Identifiable { let id: String; let depth: Int; let ref: String; let role: String; let name: String }
    let rows: [Row]
    let truncated: Bool
}

/// A device model's real look from its SDK, shaped by `bridge/phone-chrome.ts`: PNG or WebP
/// images as data URLs, and where everything goes for each turn in points.
struct DeviceChromeArt: Codable, Sendable, Equatable {
    struct Box: Codable, Sendable, Equatable { let left: Double; let top: Double; let width: Double; let height: Double }
    struct Size: Codable, Sendable, Equatable { let width: Double; let height: Double }
    /// A rectangle as fractions of the upright body.
    struct Fraction: Codable, Sendable, Equatable { let x: Double; let y: Double; let width: Double; let height: Double }
    struct Cutout: Codable, Sendable, Equatable { let image: String; let rect: Fraction }
    struct Button: Codable, Sendable, Equatable {
        let label: String
        /// The key a press sends; empty for hardware ace can't press.
        let key: String
        let image: String
        let pressed: String?
        let onTop: Bool
        let rect: Fraction
    }
    struct Turn: Codable, Sendable, Equatable { let box: Size; let plate: Box; let screen: Box }
    let body: String
    let mask: String?
    let cutout: Cutout?
    let buttons: [Button]
    /// Upright, then turned a quarter, a half and three quarters clockwise.
    let turns: [Turn]
}

enum DevicesPatch: Sendable {
    case view(threadId: String, DevicesView)
    case logs(DeviceLogs)
    case chrome(key: String, DeviceChromeArt)
    /// The live stream's stats, worded by the bridge (`bridge/device-stats.ts`).
    case stats(DeviceStreamStats)

    static let types: Set<String> = ["devices.view", "devices.logs", "devices.chrome", "devices.stats"]
    private enum Keys: String, CodingKey { case type, threadId, view, key, chrome }
    init(from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: Keys.self)
        let type = try box.decode(String.self, forKey: .type)
        if type == "devices.view" {
            self = .view(threadId: try box.decode(String.self, forKey: .threadId), try box.decode(DevicesView.self, forKey: .view))
        } else if type == "devices.stats" {
            self = .stats(try DeviceStreamStats(from: decoder))
        } else if type == "devices.chrome" {
            self = .chrome(key: try box.decode(String.self, forKey: .key), try box.decode(DeviceChromeArt.self, forKey: .chrome))
        } else {
            self = .logs(try DeviceLogs(from: decoder))
        }
    }
}

/// "H.264 · 59 fps" and the lines under it: what arrived, what was drawn, the stalls.
struct DeviceStreamStats: Codable, Sendable, Equatable {
    let deviceId: String
    let summary: String
    let details: [String]
}

/// The Devices screen's state on the phone: what the bridge last shaped, the open logs, and the
/// one live picture pipeline. Every action is one request; a refusal shows its words.
@MainActor @Observable final class DevicesModel {
    private(set) var view: DevicesView?
    private(set) var logs: DeviceLogs?
    /// Each model's real look the bridge has sent, its images decoded once.
    private(set) var chromes: [String: DeviceChromeLook] = [:]
    /// The open device's stream stats while they show.
    var stats: DeviceStreamStats?
    /// The newest request's failure, until the next one starts.
    var problem: DeviceProblem?
    private(set) var pending = 0
    let live = DeviceLiveModel()
    @ObservationIgnored private var watching: [String: Any]?

    var busy: Bool { pending > 0 }
    func apply(_ patch: DevicesPatch) {
        switch patch {
        case .view(_, let next): if view != next { view = next }
        case .logs(let next): if logs != next { logs = next }
        case .chrome(let key, let art):
            if chromes[key]?.art != art, let look = DeviceChromeLook(art) { chromes[key] = look }
        case .stats(let next): if stats != next { stats = next }
        }
    }

    /// Show the thread's devices (and `deviceId`'s screen), searched as the Start sheet asks.
    func watch(_ model: ClientModel, threadId: String?, deviceId: String?, query: String = "", platform: String = "all") {
        var value: [String: Any] = ["type": "native.devices.view", "query": query, "platform": platform]
        if let threadId { value["threadId"] = threadId }
        if let deviceId { value["deviceId"] = deviceId }
        watching = value
        model.action(value)
    }
    /// Ask again after a reconnect: the bridge reads the inventory each time a screen opens.
    func rewatch(_ model: ClientModel) { if let watching { model.action(watching) } }
    func close(_ model: ClientModel) {
        watching = nil
        model.action(["type": "native.devices.view.close"])
    }

    /// One device request from `threadId`; the bridge takes control first when it's needed.
    @discardableResult func perform(_ model: ClientModel, threadId: String?, _ operation: [String: Any]) async -> Bool {
        guard model.connection == "ready", model.canOperate else { return false }
        problem = nil
        pending += 1
        defer { pending -= 1 }
        var request: [String: Any] = ["type": "devices.request", "operation": operation]
        if let threadId { request["threadId"] = threadId }
        return await send(model, request)
    }
    /// Read the inventory and every device's state again; reading needs no control.
    func refresh(_ model: ClientModel) async {
        guard model.connection == "ready" else { return }
        problem = nil
        if await send(model, ["type": "devices.request", "operation": ["op": "list"]]) {
            await send(model, ["type": "devices.request", "operation": ["op": "states"]])
        }
    }
    /// A finger's press and release on the live screen, in device points and milliseconds.
    func gesture(_ model: ClientModel, threadId: String?, deviceId: String, from: DevicePress, to: DevicePress) {
        guard model.connection == "ready", model.canOperate else { return }
        var request: [String: Any] = ["type": "devices.gesture", "deviceId": deviceId, "start": from.json, "end": to.json]
        if let threadId { request["threadId"] = threadId }
        Task { await send(model, request) }
    }
    func tree(_ model: ClientModel, deviceId: String) async throws -> DeviceTree {
        let reply = try await model.service(["type": "devices.tree", "deviceId": deviceId], as: DeviceServiceReply<DeviceTree>.self)
        guard reply.ok, let tree = reply.data else { throw ServiceFailure(message: reply.error?.text ?? "Couldn't read the screen.") }
        return tree
    }
    func showLogs(_ model: ClientModel, deviceId: String, filter: String) {
        model.action(["type": "native.devices.logs", "deviceId": deviceId, "on": true, "filter": filter])
    }
    func hideLogs(_ model: ClientModel, deviceId: String) {
        logs = nil
        model.action(["type": "native.devices.logs", "deviceId": deviceId, "on": false])
    }

    /// Watch a live device's pictures at the phone's decoder settings.
    func watchPictures(_ model: ClientModel, deviceId: String) async {
        guard model.connection == "ready", let session = model.browserSession, live.deviceId != deviceId else { return }
        live.open(deviceId: deviceId, session: session)
        // Match the host's native decoder. JPEG is reserved for stills.
        let configured = await send(model, ["type": "devices.request", "operation": ["op": "stream.configure", "deviceId": deviceId,
            "settings": ["codec": "h264", "maxWidth": 1280, "maxHeight": 1920, "fps": 60, "bitrate": 6_000_000]]])
        guard configured else { live.close(); return }
        let subscribed = await send(model, ["type": "devices.request", "operation": ["op": "subscribe", "deviceId": deviceId]])
        if !subscribed { live.close() }
    }
    func unwatchPictures(_ model: ClientModel, deviceId: String) {
        live.close(deviceId: deviceId)
        model.action(["type": "native.devices.unwatch", "deviceId": deviceId])
    }

    @discardableResult private func send(_ model: ClientModel, _ request: [String: Any]) async -> Bool {
        do {
            let reply = try await model.service(request, as: DeviceServiceReply<ServiceValue>.self)
            if !reply.ok { problem = reply.error ?? DeviceProblem(message: "That didn't work.", hint: nil) }
            return reply.ok
        } catch {
            if !Task.isCancelled { problem = DeviceProblem(message: error.localizedDescription, hint: nil) }
            return false
        }
    }
}

/// Where and when a finger touched the device, in device points and milliseconds.
struct DevicePress: Equatable, Sendable {
    let point: CGPoint
    let at: Double
    var json: [String: Any] { ["x": Double(point.x), "y": Double(point.y), "at": at] }
}
