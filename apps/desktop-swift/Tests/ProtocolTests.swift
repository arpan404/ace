import XCTest
@testable import AceDesktop

final class ProtocolTests: XCTestCase {
    func testDecodesProjectListResult() throws {
        let data = """
        {
          "version": 1,
          "request_id": "req",
          "payload": {
            "type": "result",
            "body": [
              {
                "id": "project-1",
                "title": "ace",
                "workspace_root": "/tmp/ace"
              }
            ]
          }
        }
        """.data(using: .utf8)!

        let response = try JSONDecoder().decode(WsServerResponse<[Project]>.self, from: data)
        guard case let .result(projects) = response.payload else {
            XCTFail("expected result")
            return
        }
        XCTAssertEqual(projects.first?.workspaceRoot, "/tmp/ace")
    }

    func testEncodesProjectAddSnakeCasePayload() throws {
        let request = WsClientRequest(
            method: WsMethod.projectsAdd,
            payload: ProjectAddRequest(
                workspaceRoot: "/tmp/ace",
                title: nil,
                defaultModelSelection: nil
            )
        )
        let data = try JSONEncoder().encode(request)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let payload = object?["payload"] as? [String: Any]
        XCTAssertEqual(payload?["workspace_root"] as? String, "/tmp/ace")
        XCTAssertNotNil(object?["request_id"])
    }

    func testEncodesThreadRequestsWithBackendFieldNames() throws {
        let request = WsClientRequest(
            method: WsMethod.codexThreadStart,
            payload: ThreadStartRequest(
                cwd: "/tmp/ace",
                model: "gpt-5.5",
                approvalPolicy: ["preset": "on-request"]
            )
        )
        let data = try JSONEncoder().encode(request)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let payload = object?["payload"] as? [String: Any]

        XCTAssertEqual(payload?["cwd"] as? String, "/tmp/ace")
        XCTAssertEqual(payload?["model"] as? String, "gpt-5.5")
        XCTAssertNotNil(payload?["approval_policy"])

        let list = WsClientRequest(
            method: WsMethod.codexThreadsList,
            payload: ThreadsListRequest(includeArchived: false, limit: 20)
        )
        let listData = try JSONEncoder().encode(list)
        let listObject = try JSONSerialization.jsonObject(with: listData) as? [String: Any]
        let listPayload = listObject?["payload"] as? [String: Any]
        XCTAssertEqual(listPayload?["include_archived"] as? Bool, false)
        XCTAssertEqual(listPayload?["limit"] as? Int, 20)
    }

    func testDecodesThreadListAndReadResponses() throws {
        let listData = """
        {
          "version": 1,
          "request_id": "threads",
          "payload": {
            "type": "result",
            "body": {
              "threads": [
                {
                  "id": "thread-1",
                  "title": "Rust port",
                  "updated_at": "2026-06-24T00:00:00Z",
                  "cwd": "/tmp/ace"
                }
              ]
            }
          }
        }
        """.data(using: .utf8)!

        let listResponse = try JSONDecoder().decode(
            WsServerResponse<ThreadListResponse>.self,
            from: listData
        )
        guard case let .result(list) = listResponse.payload else {
            XCTFail("expected thread list")
            return
        }
        XCTAssertEqual(list.threads.first?.id, "thread-1")
        XCTAssertEqual(list.threads.first?.projectRoot, "/tmp/ace")

        let readData = """
        {
          "version": 1,
          "request_id": "read",
          "payload": {
            "type": "result",
            "body": {
              "messages": [
                {
                  "id": "message-1",
                  "role": "user",
                  "text": "hello"
                }
              ]
            }
          }
        }
        """.data(using: .utf8)!

        let readResponse = try JSONDecoder().decode(
            WsServerResponse<ThreadReadResponse>.self,
            from: readData
        )
        guard case let .result(read) = readResponse.payload else {
            XCTFail("expected thread read")
            return
        }
        XCTAssertEqual(read.messages.first?.text, "hello")
        XCTAssertEqual(read.messages.first?.role, .user)
    }
}
