/// What the Diagnostics page is waiting on: a checks run going on the machine, at one connection.
/// A new ready connection changes the key, so a run that outlived a dropped connection is joined
/// again rather than left unwatched.
struct HostChecksJoin: Equatable {
    let runId: String
    let reconnects: Int
    let generation: Int

    init?(checks: HostChecksReply?, reconnects: Int, generation: Int) {
        guard let checks, checks.state == "running", let runId = checks.runId else { return nil }
        self.runId = runId
        self.reconnects = reconnects
        self.generation = generation
    }
}
