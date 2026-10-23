/// This classification is for takeover only, never an authorization identity check. Unknown
/// sources and physical HID events stop work. Agent process ids come from the trusted owner,
/// not from event user-data tags or a tool request.
public func lockedUseIsTakeover(sourcePID: Int32, agentProcessIDs: Set<Int32>) -> Bool {
    sourcePID <= 0 || !agentProcessIDs.contains(sourcePID)
}
