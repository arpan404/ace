import Foundation

/// The VM boundary is injectable so lifecycle races can be exercised without timing sleeps.
protocol ClientSession: AnyObject, Sendable {
    func start(itemLimit: Int)
    func invoke(_ name: String, json: String)
    func acknowledge(accepted: Bool)
    func stop(completion: @escaping @Sendable () -> Void)
    /// Where the runtime's sockets deliver browser stream messages; nil without a live socket.
    var browserStreams: BrowserStreamHub? { get }
}
extension ClientSession {
    var browserStreams: BrowserStreamHub? { nil }
}

typealias ClientSessionFactory = @MainActor (
    ConnectionTarget, URL, @escaping @Sendable (Data) -> Void,
    @escaping @Sendable (String) -> Void
) -> any ClientSession
