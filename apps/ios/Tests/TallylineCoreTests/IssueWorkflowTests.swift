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
