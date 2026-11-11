/// Refresh the live page without dropping older pages that the person already loaded.
func refreshedAutomationHistory<Row: Identifiable>(_ newest: [Row], keeping rows: [Row], startedAt: (Row) -> Double) -> [Row] {
    let ids = Set(newest.map(\.id))
    let boundary = newest.last.map(startedAt) ?? .infinity
    return newest + rows.filter { !ids.contains($0.id) && startedAt($0) <= boundary }
}
