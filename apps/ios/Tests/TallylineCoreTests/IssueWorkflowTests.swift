import XCTest
@testable import TallylineCore

final class IssueWorkflowTests: XCTestCase {
    private func issue(_ id: String, _ state: IssueState, _ priority: IssuePriority = .none, updated: TimeInterval = 0) -> Issue {
        Issue(id: id, key: "ENG-\(id)", number: Int(id) ?? 0, title: "t\(id)", description: nil, state: state, priority: priority, estimate: nil, dueDate: nil, assigneeType: nil, assigneeId: nil, delegateType: nil, delegateId: nil, creatorType: "human", creatorId: nil, projectId: nil, cycleId: nil, parentId: nil, source: "web", occurrenceCount: 1, createdAt: Date(timeIntervalSince1970: 0), updatedAt: Date(timeIntervalSince1970: updated))
    }

    func testForwardIsAlwaysALegalTransition() {
        for state in IssueState.allCases {
            if let next = state.forward { XCTAssertTrue(state.transitions.contains(next), "\(state) -> \(next)") }
        }
        XCTAssertNil(IssueState.inReview.forward, "review is decided on the detail screen")
        XCTAssertNil(IssueState.done.forward)
    }

    func testTerminalStatesHaveNoExits() {
        for state in [IssueState.done, .canceled, .duplicate] { XCTAssertTrue(state.transitions.isEmpty) }
    }

    func testListOrderIsAUniquePermutation() {
        XCTAssertEqual(Set(IssueState.allCases.map(\.listOrder)).count, IssueState.allCases.count)
    }

    func testSectionsOrderAndSort() {
        let rows = [
            issue("1", .done), issue("2", .todo, .low, updated: 5), issue("3", .todo, .urgent, updated: 1),
            issue("4", .triage), issue("5", .todo, .low, updated: 9),
        ]
        let sections = IssueGrouping.sections(rows)
        XCTAssertEqual(sections.map(\.state), [.triage, .todo, .done])
        XCTAssertEqual(sections[1].issues.map(\.id), ["3", "5", "2"])
    }

    func testPriorityBars() {
        XCTAssertEqual(IssuePriority.allCases.map(\.barCount).sorted(), [0, 1, 2, 3, 3])
    }

    func testProgressFraction() {
        XCTAssertEqual(ProgressMath.fraction(done: 0, total: 0), 0)
        XCTAssertEqual(ProgressMath.fraction(done: 1, total: 4), 0.25)
        XCTAssertEqual(ProgressMath.fraction(done: 9, total: 4), 1)
    }
}

final class PatchClearTests: XCTestCase {
    private func json(_ patch: IssuePatch) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any] ?? [:]
    }

    func testClearedFieldsSendNull() throws {
        let body = try json(IssuePatch(cleared: [.assignee, .project]))
        XCTAssertTrue(body["assigneeId"] is NSNull)
        XCTAssertTrue(body["assigneeType"] is NSNull)
        XCTAssertTrue(body["projectId"] is NSNull)
        XCTAssertNil(body["cycleId"], "untouched fields are left out")
    }

    func testPlainPatchOmitsNils() throws {
        XCTAssertEqual(try json(IssuePatch(state: .todo)).keys.sorted(), ["state"])
    }

    func testClearedSurvivesTheOutbox() throws {
        let patch = IssuePatch(priority: .high, cleared: [.cycle])
        let back = try JSONDecoder().decode(IssuePatch.self, from: JSONEncoder().encode(patch))
        XCTAssertEqual(back, patch)
    }

    func testAppliedClearAndLabels() {
        let label = IssueLabel(id: "l1", name: "bug")
        var issue = Issue(id: "1", key: "ENG-1", number: 1, title: "t", description: nil, state: .todo, priority: .none, estimate: nil, dueDate: nil, assigneeType: "human", assigneeId: "u", delegateType: nil, delegateId: nil, creatorType: "human", creatorId: nil, projectId: "p", cycleId: "c", parentId: nil, source: "web", occurrenceCount: 1, createdAt: Date(timeIntervalSince1970: 0), updatedAt: Date(timeIntervalSince1970: 0))
        issue.labels = [label, IssueLabel(id: "l2", name: "ui")]
        let next = issue.applying(IssuePatch(labelIds: ["l1"], cleared: [.assignee, .project]))
        XCTAssertNil(next.assigneeId)
        XCTAssertNil(next.assigneeType)
        XCTAssertNil(next.projectId)
        XCTAssertEqual(next.cycleId, "c")
        XCTAssertEqual(next.labels, [label])
    }

    func testMembersCarryTheUserId() throws {
        let data = Data(#"{"members":[{"id":"m1","userId":"u1","name":"A","email":null,"role":"member"}]}"#.utf8)
        let list = try APIClient.decoder.decode(MemberList.self, from: data)
        XCTAssertEqual(list.members.first?.userId, "u1")
    }

    func testIssueListDecodesLabelsAndBlocked() throws {
        let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures")
        let page = try APIClient.decoder.decode(IssuePage.self, from: Data(contentsOf: dir.appendingPathComponent("issues_list.json")))
        XCTAssertNotNil(page.issues.first?.labels)
        XCTAssertNotNil(page.issues.first?.blocked)
    }
}
