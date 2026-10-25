import XCTest
import Foundation
import LockedUseIPC

final class PeerTests: XCTestCase {
    func testAProcessOutsideTheAppleAuthorizationHostCannotRequestADecision() {
        let listener = NSXPCListener.anonymous()
        // If peer checking is removed, these otherwise-valid facts receive an allow.
        let endpoint = LockedUseAuthorizationEndpoint(listener: listener, now: { 100 }, verify: { _ in true })
        endpoint.start()
        defer { endpoint.stop() }
        let connection = NSXPCConnection(listenerEndpoint: listener.endpoint)
        connection.remoteObjectInterface = NSXPCInterface(with: LockedUseAuthorizing.self)
        connection.resume()
        defer { connection.invalidate() }
        let denied = expectation(description: "untrusted process is rejected at the XPC boundary")
        let proxy = connection.remoteObjectProxyWithErrorHandler { _ in denied.fulfill() }
        guard let client = proxy as? LockedUseAuthorizing else { XCTFail("Could not request authorization through XPC"); return }
        client.authorize(attempt: "fixture", transaction: Data(repeating: 1, count: MemoryLayout<UnsafeRawPointer>.size),
            request: UUID().uuidString, deadline: 200) { _ in
            XCTFail("A non-authorization-host process reached the decision endpoint")
            denied.fulfill()
        }
        wait(for: [denied], timeout: 5)
    }
}
