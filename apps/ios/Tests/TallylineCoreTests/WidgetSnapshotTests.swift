import XCTest
@testable import TallylineCore

final class WidgetSnapshotTests: XCTestCase {
    private let me = "user-ada"

    private func issue(
        _ id: String, state: IssueState = .todo, priority: IssuePriority = .none,
        assignee: String? = nil, assigneeType: String? = "human", cycle: String? = nil, updated: TimeInterval = 0
    ) -> Issue {
        Issue(
            id: id, key: "ENG-\(id)", number: Int(id) ?? 0, title: "Issue \(id)", description: nil,
            state: state, priority: priority, estimate: nil, dueDate: nil,
            assigneeType: assignee == nil ? nil : assigneeType, assigneeId: assignee, delegateType: nil, delegateId: nil,
            creatorType: "human", creatorId: nil, projectId: nil, cycleId: cycle, parentId: nil,
            source: "app", occurrenceCount: 1,
            createdAt: Date(timeIntervalSince1970: 0), updatedAt: Date(timeIntervalSince1970: updated)
        )
    }

    func testMyIssuesAreOpenAssignedToMeMostUrgentFirst() {
        let issues = [
            issue("1", priority: .low, assignee: me, updated: 50),
            issue("2", priority: .urgent, assignee: me, updated: 10),
            issue("3", priority: .low, assignee: me, updated: 90),
            issue("4", state: .done, priority: .urgent, assignee: me),
            issue("5", priority: .urgent, assignee: "someone-else"),
            issue("6", priority: .urgent, assignee: me, assigneeType: "agent"),
            issue("7", priority: .none, assignee: me),
        ]
        let snap = WidgetSnapshot.build(workspaceName: "Acme", userId: me, issues: issues, reviewCount: 3, cycles: [])
        XCTAssertEqual(snap.myIssues.map(\.id), ["2", "3", "1", "7"])
        XCTAssertEqual(snap.myIssueCount, 4)
        XCTAssertEqual(snap.reviewCount, 3)
        XCTAssertNil(snap.cycle)
    }

    func testRowsAreCappedButTheCountIsNot() {
        let issues = (1...9).map { issue(String($0), assignee: me) }
        let snap = WidgetSnapshot.build(workspaceName: "Acme", userId: me, issues: issues, reviewCount: 0, cycles: [])
        XCTAssertEqual(snap.myIssues.count, WidgetSnapshot.rowLimit)
        XCTAssertEqual(snap.myIssueCount, 9)
    }

    func testCycleProgressCountsDoneAndSkipsCanceled() {
        let now = Date(timeIntervalSince1970: 1_000)
        let cycles = [
            Cycle(id: "old", name: "Old", number: 1, startsAt: Date(timeIntervalSince1970: 0), endsAt: Date(timeIntervalSince1970: 500), isActive: false),
            Cycle(id: "c2", name: nil, number: 2, startsAt: Date(timeIntervalSince1970: 900), endsAt: Date(timeIntervalSince1970: 2_000), isActive: false),
        ]
        let issues = [
            issue("1", state: .done, cycle: "c2"),
            issue("2", state: .inProgress, cycle: "c2"),
            issue("3", state: .canceled, cycle: "c2"),
            issue("4", state: .done, cycle: "old"),
        ]
        let snap = WidgetSnapshot.build(workspaceName: "Acme", userId: me, issues: issues, reviewCount: 0, cycles: cycles, now: now)
        XCTAssertEqual(snap.cycle, .init(name: "Cycle 2", done: 1, total: 2, endsAt: Date(timeIntervalSince1970: 2_000)))
        XCTAssertEqual(snap.cycle?.fraction, 0.5)
    }

    func testTheFlaggedActiveCycleWins() {
        let cycles = [
            Cycle(id: "a", name: "By date", number: 1, startsAt: .distantPast, endsAt: .distantFuture, isActive: false),
            Cycle(id: "b", name: "Flagged", number: 2, startsAt: nil, endsAt: nil, isActive: true),
        ]
        let snap = WidgetSnapshot.build(workspaceName: "Acme", userId: me, issues: [], reviewCount: 0, cycles: cycles)
        XCTAssertEqual(snap.cycle?.name, "Flagged")
        XCTAssertEqual(snap.cycle?.fraction, 0)
    }

    func testRoundTripsThroughTheFileStore() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = JSONFileStore<WidgetSnapshot>.standard(named: "widget", in: dir)
        try store.write(.placeholder)
        XCTAssertEqual(try store.read(), .placeholder)
    }

    func testAppLinks() {
        XCTAssertEqual(AppLink.url(.review).absoluteString, "tallyline://open/review")
        XCTAssertEqual(AppLink.destination(AppLink.url(.myIssues)), .myIssues)
        XCTAssertEqual(AppLink.destination(AppLink.url(.review)), .review)
        XCTAssertNil(AppLink.destination(URL(string: "tallyline://pair?c=1")!))
        XCTAssertNil(AppLink.destination(URL(string: "https://open/issues")!))
    }
}
