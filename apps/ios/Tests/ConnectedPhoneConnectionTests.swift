import Foundation
import Testing
@testable import Ace

/// Read-only checks on the saved pairing. Credentials remain in Keychain and the pinned transport.
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
    @Test func openingTheCurrentConversationDeliversWorkContentBeforeItIsReady() async throws {
        struct Directory: Decodable { let machines: [MachineEntry] }
        let directory = try ProductionApp.storageDirectory()
        let saved = try JSONDecoder().decode(Directory.self, from: Data(contentsOf: ProductionApp.machineDirectory(in: directory)))
        let target = try #require(saved.machines.first?.connectionTarget)
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let machines = MachinesModel(access: BridgeMachineAccess(directoryURL: ProductionApp.machineDirectory(in: directory)), storage: temporary, makeClient: { ClientModel(now: { Date().timeIntervalSince1970 * 1000 }) })
        await machines.load()
        let model = try #require(machines.inbox.client(target.hostId))
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: temporary) } }
        for _ in 0..<200 where model.connection != "ready" { try await Task.sleep(for: .milliseconds(100)) }
        try #require(model.connection == "ready")
        model.open("01a15b0e-7eef-705b-a011-fde54ae8afd1")
        for _ in 0..<200 where model.thread?.loaded != true { try await Task.sleep(for: .milliseconds(100)) }
        let thread = try #require(model.thread)
        let groups = thread.screen.blocks.values.flatMap { $0.row.groups ?? [] }
        let missing = groups.filter { $0.single && thread.items[$0.id] == nil }
        #expect(thread.loaded, "Conversation never became ready: \(thread.items.count) items, \(thread.screen.blocks.count) blocks, \(missing.count) empty work rows, error \(model.error ?? "none")")
        #expect(thread.items.count <= 200, "Opening a conversation must not eagerly fetch its entire work log; older content has a separate history reader")
        #expect(!groups.isEmpty)
        #expect(missing.isEmpty, "Ready conversation contains \(missing.count) empty work rows out of \(groups.count)")
    }
    @Test func inlineHistoryPagesStayOrderedAndLeaveTheLiveTailSubscribed() async throws {
        struct Directory: Decodable { let machines: [MachineEntry] }
        struct Reading: Decodable {
            struct Row: Decodable { let id: String; let seq: Int }
            let active: Bool; let items: [Row]
        }
        let directory = try ProductionApp.storageDirectory()
        let saved = try JSONDecoder().decode(Directory.self, from: Data(contentsOf: ProductionApp.machineDirectory(in: directory)))
        let target = try #require(saved.machines.first?.connectionTarget)
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let model = ClientModel(now: { Date().timeIntervalSince1970 * 1000 })
        await model.connect(target: target, directory: temporary)
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: temporary) } }
        for _ in 0..<200 where model.connection != "ready" { try await Task.sleep(for: .milliseconds(100)) }
        let id = "01a15b0e-7eef-705b-a011-fde54ae8afd1"
        model.open(id)
        for _ in 0..<200 where model.thread?.loaded != true { try await Task.sleep(for: .milliseconds(100)) }
        try #require(model.thread?.loaded == true)
        let hold = try await model.service(["type": "native.transcript", "threadId": id, "operation": "hold"], as: Reading.self)
        let first = try #require(hold.items.first?.seq)
        var oldest = first
        for _ in 0..<2 {
            let page = try await model.service(["type": "native.transcript", "threadId": id, "operation": "older"], as: Reading.self)
            #expect(page.active)
            #expect(page.items.count <= 2200)
            #expect(Set(page.items.map(\.id)).count == page.items.count)
            #expect(zip(page.items, page.items.dropFirst()).allSatisfy { $0.seq < $1.seq })
            let next = try #require(page.items.first?.seq)
            #expect(next < oldest, "Each upward page must reach earlier creation sequences")
            oldest = next
            #expect(model.thread?.loaded == true && (model.thread?.items.count ?? 0) <= 200)
        }
        let live = try await model.service(["type": "native.transcript", "threadId": id, "operation": "live"], as: Reading.self)
        #expect(!live.active)
    }
    @Test func anEarlierMessageCanBeReadWithoutReplacingTheLiveConversation() async throws {
        struct Directory: Decodable { let machines: [MachineEntry] }
        struct Window: Decodable {
            struct Row: Decodable { let id: String; let type: String; let text: String }
            let rows: [Row]
        }
        struct Full: Decodable { let text: String }
        let directory = try ProductionApp.storageDirectory()
        let saved = try JSONDecoder().decode(Directory.self, from: Data(contentsOf: ProductionApp.machineDirectory(in: directory)))
        let target = try #require(saved.machines.first?.connectionTarget)
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let model = ClientModel(now: { Date().timeIntervalSince1970 * 1000 })
        await model.connect(target: target, directory: temporary)
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: temporary) } }
        for _ in 0..<200 where model.connection != "ready" { try await Task.sleep(for: .milliseconds(100)) }
        try #require(model.connection == "ready")
        let threadId = "01a15b0e-7eef-705b-a011-fde54ae8afd1"
        model.open(threadId)
        for _ in 0..<200 where model.thread?.loaded != true { try await Task.sleep(for: .milliseconds(100)) }
        try #require(model.thread?.loaded == true)
        let window = try await model.service(["type": "native.history.window", "threadId": threadId, "aroundSeq": 0], as: Window.self)
        let earlier = try #require(window.rows.first { $0.type == "message" && !$0.text.isEmpty })
        #expect(model.thread?.items[earlier.id] == nil, "The history window must remain separate from the live tail")
        let full = try await model.service(["type": "native.message", "threadId": threadId, "itemId": earlier.id], as: Full.self)
        #expect(full.text.contains(earlier.text))
        #expect(model.thread?.items[earlier.id] == nil, "Reading a historical message must preserve the live tail")
    }
    @Test func pairedProjectsPluginsAccountsAndDevicesAnswerThroughTheNativeBridge() async throws {
        struct Directory: Decodable { let machines: [MachineEntry] }
        struct ProjectReply: Decodable { struct Result: Decodable { let kind: String; let projects: [NativeProject]?; let code: String? }; let result: Result }
        struct AccountReply: Decodable { struct Result: Decodable { let ok: Bool }; let result: Result }
        struct Inventory: Decodable { struct Device: Decodable { let id: String }; let devices: [Device] }
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
