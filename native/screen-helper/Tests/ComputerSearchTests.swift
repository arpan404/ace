import XCTest
@testable import ScreenHelper

final class ComputerSearchTests: XCTestCase {
    func testCandidatesAgreeWithTheDaemonsVersionedSearchExamples() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixture/ComputerSearch.json")
        let fixture = try JSONDecoder().decode(SearchFixture.self, from: Data(contentsOf: url))
        let index = CUOutlineSearchIndex(nodes: fixture.nodes.map(\.node))
        for sample in fixture.cases {
            XCTAssertEqual(index.candidates(query: sample.query).map(\.id), sample.candidates, sample.query)
        }
    }
    func testSearchReturnsMatchesWithTheirOwnAncestorsInOriginalOrder() {
        let nodes = [
            cuTestNode(1, depth: 0, role: "window", name: "Owned"),
            cuTestNode(2, depth: 1, role: "group", name: "First"),
            cuTestNode(3, depth: 2, name: "Invoice"),
            cuTestNode(4, depth: 1, role: "group", name: "Second"),
            cuTestNode(5, depth: 2, name: "Unrelated"),
            cuTestNode(6, depth: 2, name: "INVOICE archive"),
        ]
        XCTAssertEqual(CUOutlineSearchIndex(nodes: nodes).candidates(query: "invoice").map(\.id), [1, 2, 3, 4, 6])
        XCTAssertTrue(CUOutlineSearchIndex(nodes: nodes).candidates(query: "Absent").isEmpty)
    }

    func testQueriesCanMatchOutlineLabelsIdsAndEscapedText() {
        let nodes = [cuTestNode(12, role: "text field", name: "Draft", value: "line\nnext\tend", placeholder: "Subject")]
        for query in ["12 text field Draft", "VALUE: line\\nnext\\tend", "Placeholder: Subject"] {
            XCTAssertEqual(CUOutlineSearchIndex(nodes: nodes).candidates(query: query).map(\.id), [12], query)
        }
        XCTAssertTrue(CUOutlineSearchIndex(nodes: nodes).candidates(query: "line\nnext").isEmpty)
    }

    func testUnicodeLinesAreRetainedForTheDaemonsCanonicalCaseMatching() {
        let nodes = [cuTestNode(1, depth: 0, name: "Root"), cuTestNode(2, name: "Invoice"), cuTestNode(3, name: "İstanbul")]
        XCTAssertEqual(CUOutlineSearchIndex(nodes: nodes).candidates(query: "unmatched ascii").map(\.id), [1, 3])
        XCTAssertEqual(CUOutlineSearchIndex(nodes: nodes).candidates(query: "İ").map(\.id), [1, 2, 3])
    }

    func testFlagsUrlsAndCustomActionsRemainSearchable() {
        let node = CUNode(id: 7, depth: 0, role: "button", flags: ["disabled"], name: "Owned", value: nil,
            detail: "help", placeholder: nil, url: "https://example.test/path", actions: ["increment"], frame: nil,
            axActions: ["AXIncrement"], axRole: "AXButton")
        for query in ["(disabled)", "Description: help", "URL: https://example.test/path", "Actions: increment"] {
            XCTAssertEqual(CUOutlineSearchIndex(nodes: [node]).candidates(query: query).map(\.id), [7], query)
        }
    }
}

private struct SearchFixture: Decodable {
    let nodes: [SearchFixtureNode]
    let cases: [SearchFixtureCase]
}
private struct SearchFixtureCase: Decodable {
    let query: String
    let candidates: [Int]
}
private struct SearchFixtureNode: Decodable {
    let id: Int
    let depth: Int
    let role: String
    let flags: [String]?
    let name: String?
    let value: String?
    let detail: String?
    let placeholder: String?
    let url: String?
    let actions: [String]?

    var node: CUNode {
        CUNode(id: id, depth: depth, role: role, flags: flags ?? [], name: name, value: value,
            detail: detail, placeholder: placeholder, url: url, actions: actions ?? [],
            frame: nil, axActions: [], axRole: "AXGroup")
    }
}
