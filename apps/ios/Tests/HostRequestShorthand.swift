import Foundation
@testable import Ace

/// `perform("operation", input:, body:)` for tests that call a native store directly.
private func request(_ operation: String, _ input: Data, _ body: String?) -> HostRequest {
    HostRequest(operation, input: input, body: body)
}
extension DurableStore {
    func perform(_ operation: String, input: Data = Data("null".utf8), body: String? = nil) throws -> String {
        try perform(request(operation, input, body))
    }
}
extension SnapshotStore {
    func perform(_ operation: String, input: Data = Data("null".utf8), body: String? = nil) throws -> String? {
        try perform(request(operation, input, body))
    }
}
extension HostServices {
    func perform(_ operation: String, input: Data = Data("null".utf8), body: String? = nil) throws -> String? {
        try perform(request(operation, input, body))
    }
}
