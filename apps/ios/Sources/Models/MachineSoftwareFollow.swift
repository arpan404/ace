import Foundation

/// A machine page's Software, read and followed: one read, then while an update runs a read every
/// few seconds until its result. The update restarts the machine's ace, so reads fail or come back
/// unanswered part way; the last page stays and the wait backs off, up to `longest`, until the
/// machine answers again. Ends with its task, so a page that closes stops reading.
@MainActor @Observable final class MachineSoftwareFollow {
    static let step: Duration = .seconds(3)
    static let longest: Duration = .seconds(15)
    private(set) var data: MachineSoftwareData?
    private(set) var problem: String?
    @ObservationIgnored private let fetch: @MainActor () async throws -> MachineSoftwareData
    @ObservationIgnored private let pause: @MainActor (Duration) async throws -> Void

    init(fetch: @escaping @MainActor () async throws -> MachineSoftwareData,
         pause: @escaping @MainActor (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.fetch = fetch
        self.pause = pause
    }

    func follow() async {
        var wait = Self.step
        await read()
        while data?.updating == true, !Task.isCancelled {
            do { try await pause(wait) } catch { return }
            let answered = await read()
            wait = answered ? Self.step : min(wait * 2, Self.longest)
        }
    }

    /// True when the machine answered; a failed read keeps the page it had.
    @discardableResult func read() async -> Bool {
        do {
            let next = try await fetch()
            guard !Task.isCancelled else { return false }
            data = next
            problem = nil
            return next.reachable
        } catch {
            if data == nil, !Task.isCancelled { problem = error.localizedDescription }
            return false
        }
    }

    /// An action's answer, or why it failed.
    func show(_ next: MachineSoftwareData) { data = next }
    func fail(_ message: String) { problem = message }
}
