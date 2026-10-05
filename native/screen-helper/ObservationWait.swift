/// An observation is produced only after the UI has had a chance to settle. All waiting and
/// notification reads are supplied by the Accessibility I/O shell.
func settledObservation<T>(wait: () async throws -> Void, revision: () -> UInt64, observe: () throws -> T) async throws -> T {
    var previous = revision(), quiet = 0
    for _ in 0..<8 {
        try await wait()
        let next = revision()
        if next == previous { quiet += 1 } else { quiet = 0 }
        if quiet >= 3 { break }
        previous = next
    }
    return try observe()
}
