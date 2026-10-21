#if DEBUG
import SwiftUI

/// Local frame source for physical-phone rendering tests. Never starts a provider or network connection.
struct ChatRenderFixture: View {
    @State private var model = ClientModel(now: { 0 }, makeRuntime: { _, _, receive, _ in ChatRenderSession(receive: receive) })
    var body: some View {
        NavigationStack {
            if let thread = model.thread {
                ThreadView(model: model, thread: thread, openThread: { _ in })
            }
        }
        .task {
            guard model.thread == nil, let endpoint = URL(string: "ws://127.0.0.1:1") else { return }
            await model.connect(target: ConnectionTarget(endpoint: endpoint, hostId: "render-fixture", deviceId: "render-fixture", pin: nil, credential: { "{}" }), directory: FileManager.default.temporaryDirectory)
            model.open("render-fixture")
        }
    }
}

private final class ChatRenderSession: ClientSession, @unchecked Sendable {
    let receive: @Sendable (Data) -> Void
    private let queue = DispatchQueue(label: "ace.render-fixture")
    private var next = 0
    private var entries: [Int: [String: Any]] = [:]
    private var historyStart = 0
    private var transfer = 0
    init(receive: @escaping @Sendable (Data) -> Void) { self.receive = receive }
    func start(itemLimit: Int) { emit([["type": "connection", "state": "ready"]]) }
    func acknowledge(accepted: Bool) {}
    func stop(completion: @escaping @Sendable () -> Void) { queue.async(execute: completion) }
    func invoke(_ name: String, json: String) {
        guard let data = json.data(using: .utf8) else { return }
        queue.async { [self] in
            guard let action = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            if action["type"] as? String == "open" {
                var patches: [[String: Any]] = [scoped("thread.reset")]
                if ProcessInfo.processInfo.arguments.contains("--chat-work-fixture") {
                    patches += workFixture()
                } else {
                    for _ in 0..<80 { patches += message("Recorded conversation message \(next)", role: "assistant") }
                }
                patches.append(scoped("thread.ready", ["count": next]))
                patches.append(scoped("thread.history", ["hasOlder": true, "loading": false]))
                patches.append(scoped("thread.controls", ["row": ["busy": false, "delivery": "queue", "alternate": NSNull(), "canStop": false, "provider": "codex", "model": "Render test", "switching": ""]]))
                emit(patches)
            }
            if action["type"] as? String == "service", let id = action["id"] as? String, let request = action["request"] as? [String: Any], let operation = request["operation"] as? String {
                queue.asyncAfter(deadline: .now() + (operation == "older" ? 8.0 : 0.02)) { [self] in
                    emit([["type": "service.reply", "id": id, "ok": true, "message": "", "value": history(operation)]])
                }
            }
            if let send = action["action"] as? [String: Any], send["type"] as? String == "send",
               let id = send["requestId"] as? String, let text = send["text"] as? String {
                emit([["type": "pending", "id": id, "row": ["id": id, "threadId": "render-fixture", "state": "saving", "waiting": false, "text": text]]])
                queue.asyncAfter(deadline: .now() + 0.04) { [self] in emit([["type": "admission", "id": id, "ok": true, "message": ""]]) }
                for part in 0..<12 {
                    queue.asyncAfter(deadline: .now() + 0.08 + Double(part) * 0.015) { [self] in
                        var patches = message(part == 0 ? text : part == 11 ? "Acknowledged \(text)" : "Incoming update \(next)", role: part == 0 ? "user" : "assistant", id: part == 0 ? "input:\(id)" : nil)
                        patches.append(scoped("thread.cursor", ["cursor": next]))
                        if part == 11 { patches.append(["type": "pending", "id": id, "row": NSNull()]) }
                        emit(patches)
                    }
                }
            }
        }
    }
    private func message(_ text: String, role: String, id: String? = nil) -> [[String: Any]] {
        let key = id ?? "message-\(next)"
        let position = next; next += 1
        let row = record(key, position: position, text: text, role: role)
        entries[position] = row
        return [scoped("thread.item", ["id": key, "row": row]), scoped("thread.block", ["id": key, "row": block(key, position: position, role: role)])]
    }
    private func record(_ id: String, position: Int, text: String, role: String) -> [String: Any] {
        ["id": id, "index": position + 240, "type": "message", "role": role, "text": text, "complete": true, "createdAt": max(0, position), "agentId": "root", "truncated": false]
    }
    private func workFixture() -> [[String: Any]] {
        let ids = ["fixture-command", "fixture-narration"]
        let rows = [record(ids[0], position: 0, text: "Ran physical phone build", role: "assistant").merging(["type": "tool_call"]) { _, value in value },
                    record(ids[1], position: 1, text: "Checking the phone result.", role: "assistant")]
        let groups: [[String: Any]] = [
            ["id": "fixture-tools", "items": [ids[0]], "single": false, "label": "Ran 1 command", "icon": "shell", "running": false, "active": ids[0]],
            ["id": ids[1], "items": [ids[1]], "single": true, "label": "", "icon": "note", "running": false, "active": ids[1]]
        ]
        let work: [String: Any] = ["label": "Working", "counts": "Ran 1 command", "current": "Ran physical phone build", "ongoing": true, "outcome": "", "startedAt": Date().timeIntervalSince1970 * 1000, "failed": 0]
        return zip(ids, rows).map { scoped("thread.item", ["id": $0.0, "row": $0.1]) } +
            [scoped("thread.block", ["id": "fixture-work", "row": ["index": 0, "kind": "work", "items": ids, "headed": false, "interactionId": "", "work": work, "groups": groups]])]
    }
    private func block(_ id: String, position: Int, role: String) -> [String: Any] {
        ["index": position + 240, "kind": role == "user" ? "user" : "message", "items": [id], "headed": false, "interactionId": ""]
    }
    private func history(_ operation: String) -> [String: Any] {
        if operation == "live" { historyStart = 0 }
        if operation == "older" { historyStart = max(-240, historyStart - 20) }
        let rows = (historyStart..<next).compactMap { index -> [String: Any]? in
            index < 0 ? record("older-\(index)", position: index, text: "Older message \(-index). This is an earlier part of the same conversation.", role: "assistant") : entries[index]
        }
        let blocks = rows.enumerated().compactMap { offset, row -> [String: Any]? in
            guard let id = row["id"] as? String, let role = row["role"] as? String else { return nil }
            return ["id": id, "row": block(id, position: offset, role: role)]
        }
        return ["active": operation != "live", "hasOlder": historyStart > -240, "hasNewer": false, "joined": true, "items": rows, "blocks": blocks]
    }
    private func scoped(_ type: String, _ fields: [String: Any] = [:]) -> [String: Any] {
        fields.merging(["type": type, "threadId": "render-fixture", "epoch": 1]) { _, value in value }
    }
    private func emit(_ patches: [[String: Any]]) {
        // Exercise the same frame admission as production: at most 32 patches / 32 KiB.
        // A service reply may itself exceed that budget, so send its acknowledged fragments.
        var batch: [[String: Any]] = []
        func flush() {
            guard !batch.isEmpty, let data = try? JSONSerialization.data(withJSONObject: batch) else { return }
            receive(data)
            batch.removeAll(keepingCapacity: true)
        }
        for patch in patches {
            guard let bytes = try? JSONSerialization.data(withJSONObject: patch) else { continue }
            if bytes.count > 32766 {
                flush()
                transfer += 1
                let chunks = stride(from: 0, to: bytes.count, by: 18432)
                for (index, offset) in chunks.enumerated() {
                    let end = min(offset + 18432, bytes.count)
                    let fragment: [String: Any] = ["type": "fragment", "id": "fixture-\(transfer)", "index": index, "last": end == bytes.count, "data": bytes.subdata(in: offset..<end).base64EncodedString()]
                    if let data = try? JSONSerialization.data(withJSONObject: [fragment]) { receive(data) }
                }
            } else {
                if batch.count == 32 || ((try? JSONSerialization.data(withJSONObject: batch + [patch]).count) ?? Int.max) > 32768 { flush() }
                batch.append(patch)
            }
        }
        flush()
    }
}
#endif
