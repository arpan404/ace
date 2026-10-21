import Foundation
import Observation

struct RemoteDevice: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let platform: String
    let state: String
    let runtime: String?
}
struct RemoteDeviceState: Decodable {
    let device: RemoteDevice
    let enabled: Bool
    let lifecycle: String
    let controller: String
    let ownedHere: Bool?
    let recording: Bool?
    let error: DeviceProblem?
}
struct DeviceProblem: Decodable { let message: String; let hint: String? }
struct DeviceServiceReply<T: Decodable>: Decodable {
    let ok: Bool
    let data: T?
    let error: DeviceProblem?
}
private struct DeviceInventoryReply: Decodable { let devices: [RemoteDevice]; let issues: [DeviceProblem] }
private struct DeviceStatesReply: Decodable { let states: [RemoteDeviceState]; let enabled: Bool? }

@MainActor @Observable final class RemoteDevices {
    private(set) var devices: [RemoteDevice] = []
    private(set) var states: [RemoteDeviceState] = []
    private(set) var issues: [DeviceProblem] = []
    private(set) var enabled = false
    private(set) var loaded = false
    private(set) var busy = false
    private(set) var problem: String?
    let live = DeviceLiveModel()
    func state(_ id: String) -> RemoteDeviceState? { states.first { $0.device.id == id } }
    func refresh(_ model: ClientModel) async {
        do {
            let inventory: DeviceInventoryReply = try await request(model, ["op": "list"])
            let status: DeviceStatesReply = try await request(model, ["op": "states"])
            guard !Task.isCancelled else { return }
            devices = inventory.devices; issues = inventory.issues; states = status.states
            enabled = status.enabled ?? status.states.first?.enabled ?? false
            loaded = true; problem = nil
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
    func perform(_ model: ClientModel, operation: [String: Any]) async -> Bool {
        guard model.connection == "ready", model.canOperate, !busy else { return false }
        busy = true; problem = nil
        defer { busy = false }
        do { let _: ServiceValue = try await request(model, operation); await refresh(model); return true }
        catch { if !Task.isCancelled { problem = error.localizedDescription }; return false }
    }
    func input(_ model: ClientModel, deviceId: String, _ input: [String: Any]) async -> Bool {
        guard model.connection == "ready", model.canOperate, state(deviceId)?.ownedHere == true, state(deviceId)?.controller == "human" else { return false }
        do { let _: ServiceValue = try await request(model, ["op": "input", "deviceId": deviceId, "input": input]); return true }
        catch { if !Task.isCancelled { problem = error.localizedDescription }; return false }
    }
    func watch(_ model: ClientModel, deviceId: String) async {
        guard model.connection == "ready", let session = model.browserSession else { return }
        live.open(deviceId: deviceId, session: session)
        do {
            // Match the host's native decoder. JPEG is reserved for stills.
            let _: ServiceValue = try await request(model, ["op": "stream.configure", "deviceId": deviceId,
                "settings": ["codec": "h264", "maxWidth": 1280, "maxHeight": 1920, "fps": 60, "bitrate": 6_000_000]])
            let _: ServiceValue = try await request(model, ["op": "subscribe", "deviceId": deviceId])
        } catch { live.close(); if !Task.isCancelled { problem = error.localizedDescription } }
    }
    func unwatch(_ model: ClientModel, deviceId: String) async {
        live.close(deviceId: deviceId)
        model.action(["type": "native.devices.unwatch", "deviceId": deviceId])
        if state(deviceId)?.ownedHere == true { model.action(["type": "native.devices.release", "deviceId": deviceId]) }
    }
    private func request<T: Decodable>(_ model: ClientModel, _ operation: [String: Any]) async throws -> T {
        let reply = try await model.service(["type": "devices.request", "operation": operation], as: DeviceServiceReply<T>.self)
        guard reply.ok else { throw ServiceFailure(message: [reply.error?.message, reply.error?.hint].compactMap { $0 }.joined(separator: " ")) }
        if let data = reply.data { return data }
        // Successful void operations send no data. ServiceValue still represents that result.
        return try ServiceValue.null.decode(T.self)
    }
}
