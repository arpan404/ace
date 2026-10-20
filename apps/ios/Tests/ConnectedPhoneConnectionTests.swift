import Foundation
import Testing
@testable import Ace

/// Read-only transport check on the owner's saved pairing. It sends no credentials.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["ACE_IOS_CONNECTED_PHONE"] == "1", "Requires the paired physical phone"))
@MainActor struct ConnectedPhoneConnectionTests {
    @Test func thePhoneAuthenticatesAndReadsItsRealInbox() async throws {
        struct Directory: Decodable { let machines: [MachineEntry] }
        let directory = try ProductionApp.storageDirectory()
        let saved = try JSONDecoder().decode(Directory.self, from: Data(contentsOf: ProductionApp.machineDirectory(in: directory)))
        let target = try #require(saved.machines.first?.connectionTarget)
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let model = ClientModel(now: { Date().timeIntervalSince1970 * 1000 })
        await model.connect(target: target, directory: temporary)
        for _ in 0..<200 {
            if model.connection == "ready", model.inboxLoaded, !model.inbox.isEmpty { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        #expect(model.connection == "ready", "Connection \(model.connection), problem \(model.problem?.code ?? "none"), error \(model.error ?? "none")")
        #expect(model.inboxLoaded && !model.inbox.isEmpty, "The real paired daemon must return its current threads")
        if let id = model.inbox.values.first?.id {
            model.open(id)
            for _ in 0..<200 {
                if model.thread?.loaded == true, model.thread?.items.values.contains(where: { $0.row.type == "message" && $0.row.role == "assistant" && !$0.row.text.isEmpty }) == true { break }
                try await Task.sleep(for: .milliseconds(100))
            }
            if let row = model.thread?.items.values.first(where: { $0.row.type == "message" && $0.row.role == "assistant" && !$0.row.text.isEmpty })?.row {
                struct FullMessage: Decodable { let text: String }
                let full = try await model.service(["type": "native.message", "threadId": id, "itemId": row.id], as: FullMessage.self)
                #expect(full.text.contains(row.text), "The complete message must retain its displayed preview")
            } else { Issue.record("The real conversation did not load its assistant messages") }
        }
        await model.disconnectAndWait()
        try? FileManager.default.removeItem(at: temporary)
    }
    @Test func pairedProjectsPluginsAccountsAndDevicesAnswerThroughTheNativeBridge() async throws {
        struct Directory: Decodable { let machines: [MachineEntry] }
        struct ProjectReply: Decodable { struct Result: Decodable { let kind: String; let projects: [NativeProject]?; let code: String? }; let result: Result }
        struct AccountReply: Decodable { struct Result: Decodable { let ok: Bool }; let result: Result }
        struct Inventory: Decodable { let devices: [RemoteDevice] }
        let directory = try ProductionApp.storageDirectory()
        let saved = try JSONDecoder().decode(Directory.self, from: Data(contentsOf: ProductionApp.machineDirectory(in: directory)))
        let target = try #require(saved.machines.first?.connectionTarget)
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let model = ClientModel(now: { Date().timeIntervalSince1970 * 1000 })
        await model.connect(target: target, directory: temporary)
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: temporary) } }
        for _ in 0..<200 {
            if model.connection == "ready" { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        try #require(model.connection == "ready")
        let projects = try await model.service(["type": "projects.request", "operation": ["op": "workspace.list", "limit": 100]], as: ProjectReply.self)
        #expect(projects.result.kind == "projects", "Projects refused: \(projects.result.code ?? "none")")
        #expect(projects.result.projects?.isEmpty == false)
        if let project = projects.result.projects?.first {
            let catalog = try await model.service(["type": "catalog.list", "workspace": ["workspaceId": project.id, "provider": "codex"], "limit": 512], as: CatalogReply.self)
            #expect(!catalog.entries.isEmpty, "The installed CLI's available skills and commands must be discoverable")
        }
        let sourceControl = try await model.service(["type": "source-control.request", "operation": ["op": "readiness"]], as: NativeSourceControlReply.self)
        #expect(sourceControl.result.kind == "readiness")
        #expect(sourceControl.result.readiness != nil)
        let plugins = try await model.plugin(["type": "plugins.list"], expecting: "plugins.list")
        #expect(plugins.installs != nil)
        let catalog = try await model.plugin(["type": "plugins.catalog", "offset": 0, "limit": 50], expecting: "plugins.catalog")
        #expect(catalog.components != nil)
        let accounts = try await model.service(["type": "provider.accounts.list", "provider": "codex"], as: AccountReply.self)
        #expect(accounts.result.ok)
        let devices = try await model.service(["type": "devices.request", "operation": ["op": "list"]], as: DeviceServiceReply<Inventory>.self)
        #expect(devices.ok, "Devices: \(devices.error?.message ?? "none")")
        #expect(devices.data != nil)
        let screen = try await model.service(["type": "screen.request", "operation": ["op": "status"]], as: DeviceServiceReply<RemoteScreenStatus>.self)
        #expect(screen.ok, "Screen status: \(screen.error?.message ?? "none")")
        #expect(screen.data != nil)
    }
    @Test func thePhoneReachesItsPairedMachinesPinnedTicketEndpoint() async throws {
        struct Directory: Decodable { let machines: [MachineEntry] }
        let directory = try ProductionApp.storageDirectory()
        let saved = try JSONDecoder().decode(Directory.self, from: Data(contentsOf: ProductionApp.machineDirectory(in: directory)))
        let entry = try #require(saved.machines.first)
        let target = try #require(entry.connectionTarget)
        let origin = try #require(target.httpsOrigin)
        let result: Result<PinnedHTTPResponse, PinnedHTTPError> = await withCheckedContinuation { continuation in
            PinnedHTTP.send(origin: origin, pin: target.pin, request: PinnedHTTPRequest(method: "POST", path: "/v1/tickets", body: nil, token: nil)) { continuation.resume(returning: $0) }
        }
        switch result {
        case .success(let response):
            // An unauthenticated ticket request must reach the actual pinned daemon and be refused.
            #expect(response.status == 401)
        case .failure(let error):
            Issue.record("Phone could not reach its pinned paired daemon: \(error.rawValue)")
        }
    }
    @Test func thePhoneRefusesTheSameEndpointWithAChangedPin() async throws {
        struct Directory: Decodable { let machines: [MachineEntry] }
        let directory = try ProductionApp.storageDirectory()
        let saved = try JSONDecoder().decode(Directory.self, from: Data(contentsOf: ProductionApp.machineDirectory(in: directory)))
        let target = try #require(saved.machines.first?.connectionTarget)
        let origin = try #require(target.httpsOrigin)
        let result: Result<PinnedHTTPResponse, PinnedHTTPError> = await withCheckedContinuation { continuation in
            PinnedHTTP.send(origin: origin, pin: String(repeating: "0", count: 64), request: PinnedHTTPRequest(method: "POST", path: "/v1/tickets", body: nil, token: nil)) { continuation.resume(returning: $0) }
        }
        #expect(result == .failure(.pin))
    }
}
