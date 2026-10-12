import Foundation
import Testing
@testable import Ace

@Suite @MainActor struct BridgeDeliveryTests {
    @Test func anApprovalWithThreeHundredLargeActionIDsRemainsVisibleAndExact() throws {
        let model = ClientModel(now: { 0 })
        model.open("many")
        let options = (0..<300).map { index in
            ApprovalRow.Option(id: "action-\(index)-" + String(repeating: "x", count: 32768), label: "Choice \(index)", kind: "deny")
        }
        let row = ApprovalRow(id: "approval", kind: "approval", state: "pending", title: "Choose an action", description: "", command: "printf review", options: options, truncated: false)
        let bytes = try JSONEncoder().encode(InteractionPatch(type: "thread.interaction", threadId: "many", epoch: 1, id: row.id, row: row))
        var index = 0
        for offset in stride(from: 0, to: bytes.count, by: 18432) {
            let end = min(offset + 18432, bytes.count)
            let chunk = Fragment(type: "fragment", id: "transfer", index: index, last: end == bytes.count, data: bytes[offset..<end].base64EncodedString())
            model.receive(try JSONEncoder().encode([chunk]))
            index += 1
            if model.error != nil { break }
        }
        #expect(model.error == nil)
        let visible = try #require(model.thread?.approvals.first)
        #expect(visible.state == "pending")
        #expect(visible.options.count == 300)
        #expect(visible.options.first?.id == options.first?.id)
        #expect(visible.options.last?.id == options.last?.id)
    }
}
private struct InteractionPatch: Encodable { let type: String; let threadId: String; let epoch: Int; let id: String; let row: ApprovalRow }
private struct Fragment: Encodable { let type: String; let id: String; let index: Int; let last: Bool; let data: String }
