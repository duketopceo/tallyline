import XCTest
@testable import TallylineCore

final class NowFeedTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private var cal: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }

    private func merge(_ id: String, key: String, at: TimeInterval, agent: Bool = true, pr: Int? = nil) throws -> RoadmapSummary.Merge {
        let prJSON = pr.map { #","pr":{"number":\#($0),"url":"https://example.com/p","title":null,"repo":null}"# } ?? ""
        let json = #"{"id":"\#(id)","issueKey":"\#(key)","issueTitle":"t","projectId":null,"actorName":"Builder","actorType":"\#(agent ? "agent" : "human")","at":"\#(APIDate.format(now.addingTimeInterval(at)))"\#(prJSON)}"#
        return try APIClient.decoder.decode(RoadmapSummary.Merge.self, from: Data(json.utf8))
    }

    private func parked(_ id: String, at: TimeInterval) -> OutboxEntry {
        OutboxEntry(id: id, workspaceSlug: "w", operation: .addComment(key: "ENG-1", body: "x"), orderingKey: "issue:ENG-1", createdAt: now.addingTimeInterval(at), attempts: 8, nextAttemptAt: now, status: .failed(reason: "no"), lastError: "no")
    }

    func testParkedWritesLeadAndOrderIsDeterministic() throws {
        let items = NowFeed.items(
            merges: [try merge("2", key: "ENG-2", at: -100), try merge("1", key: "ENG-1", at: -100), try merge("3", key: "ENG-3", at: -10, pr: 9)],
            review: [], outbox: [parked("p", at: -5000)], fetchedAt: now, now: now
        )
        XCTAssertEqual(items.map(\.id), ["parked:p", "merge:3", "merge:1", "merge:2"])
        XCTAssertEqual(items[1].sentence, "Builder merged #9 for ENG-3")
        XCTAssertEqual(items[2].sentence, "Builder finished ENG-1")
        let again = NowFeed.items(merges: [try merge("1", key: "ENG-1", at: -100), try merge("3", key: "ENG-3", at: -10, pr: 9), try merge("2", key: "ENG-2", at: -100)], review: [], outbox: [parked("p", at: -5000)], fetchedAt: now, now: now)
        XCTAssertEqual(again.map(\.id), items.map(\.id))
    }

    func testStaleDataIsMarkedButParkedWritesAreNot() throws {
        let fetched = now.addingTimeInterval(-600)
        let items = NowFeed.items(merges: [try merge("1", key: "ENG-1", at: -700)], review: [], outbox: [parked("p", at: -1)], fetchedAt: fetched, now: now)
        XCTAssertNil(items[0].asOf)
        XCTAssertEqual(items[1].asOf, fetched)
        let fresh = NowFeed.items(merges: [try merge("1", key: "ENG-1", at: -10)], review: [], outbox: [], fetchedAt: now.addingTimeInterval(-60), now: now)
        XCTAssertNil(fresh[0].asOf)
    }

    func testGrouping() throws {
        let items = NowFeed.items(merges: [try merge("a", key: "A-1", at: -60), try merge("b", key: "B-1", at: -86_400), try merge("c", key: "C-1", at: -5 * 86_400)], review: [], outbox: [parked("p", at: -1)], fetchedAt: now, now: now)
        let groups = NowFeed.grouped(items, now: now, calendar: cal)
        XCTAssertEqual(groups.map(\.group), [.needsYou, .today, .yesterday, .earlier])
        XCTAssertEqual(NowFeed.grouped([], now: now, calendar: cal).count, 0)
    }

    func testPulseText() {
        XCTAssertEqual(PulseSummary(agentsWorking: 2, inReview: 3, waitingToSend: 1, online: true).text, "2 agents working · 3 in review · 1 waiting to send")
        XCTAssertEqual(PulseSummary(agentsWorking: 1, inReview: 0, waitingToSend: 0, online: true).text, "1 agent working")
        XCTAssertEqual(PulseSummary(agentsWorking: 0, inReview: 0, waitingToSend: 0, online: true).text, "Up to date")
        XCTAssertEqual(PulseSummary(agentsWorking: 0, inReview: 0, waitingToSend: 2, online: false).text, "Offline · 2 waiting to send")
        XCTAssertEqual(PulseSummary(agentsWorking: 0, inReview: 2, waitingToSend: 1, online: true).tapTarget, .review)
        XCTAssertEqual(PulseSummary(agentsWorking: 0, inReview: 0, waitingToSend: 1, online: true).tapTarget, .outbox)
    }

    func testAgentsWorkingCountsEachAgentOnce() {
        func issue(_ id: String, _ state: IssueState, type: String?, agent: String?) -> Issue {
            Issue(id: id, key: "E-\(id)", number: 1, title: "t", description: nil, state: state, priority: .none, estimate: nil, dueDate: nil, assigneeType: type, assigneeId: agent, delegateType: nil, delegateId: nil, creatorType: "human", creatorId: nil, projectId: nil, cycleId: nil, parentId: nil, source: "web", occurrenceCount: 1, createdAt: Date(timeIntervalSince1970: 0), updatedAt: Date(timeIntervalSince1970: 0))
        }
        let rows = [issue("1", .inProgress, type: "agent", agent: "a"), issue("2", .inProgress, type: "agent", agent: "a"), issue("3", .inProgress, type: "agent", agent: "b"), issue("4", .todo, type: "agent", agent: "c"), issue("5", .inProgress, type: "human", agent: "u")]
        XCTAssertEqual(PulseSummary.agentsWorking(in: rows), 2)
    }
}

final class RoadmapLayoutTests: XCTestCase {
    private var cal: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }
    private func date(_ y: Int, _ m: Int, _ d: Int) -> Date { cal.date(from: DateComponents(year: y, month: m, day: d))! }

    func testMonthsCoverSpansAndToday() {
        let now = date(2026, 11, 4)
        let span = RoadmapSpan(id: "m", lane: .milestones, title: "m", start: date(2027, 2, 10), end: date(2027, 2, 10), done: nil, total: nil)
        let months = RoadmapLayout.months(for: [span], now: now, calendar: cal)
        XCTAssertEqual(months.first, date(2026, 10, 1))
        XCTAssertEqual(months.last, date(2027, 3, 1))
        XCTAssertNotNil(RoadmapLayout.monthIndex(of: now, in: months, calendar: cal))
    }

    func testTodayMarkerSitsInTheRightMonth() {
        let now = date(2026, 11, 15)
        let months = RoadmapLayout.months(for: [], now: now, calendar: cal)
        let index = RoadmapLayout.monthIndex(of: now, in: months, calendar: cal)!
        let position = RoadmapLayout.position(of: now, in: months, calendar: cal)
        XCTAssertEqual(Int(position), index)
        XCTAssertGreaterThan(position, Double(index) + 0.4)
        XCTAssertLessThan(position, Double(index) + 0.6)
    }

    func testOpenProjectRunsToNowAndMissingSummaryIsZero() {
        let now = date(2026, 11, 4)
        let p = Project(id: "p", name: "Open", createdAt: date(2026, 9, 1))
        let spans = RoadmapLayout.spans(projects: [p], milestones: [], cycles: [], summary: nil, now: now, calendar: cal)
        XCTAssertEqual(spans.count, 1)
        XCTAssertEqual(spans[0].start, date(2026, 9, 1))
        XCTAssertEqual(spans[0].end, now)
        XCTAssertNil(spans[0].total)
    }

    func testProjectOrdering() {
        let a = Project(id: "a", name: "Zeta", status: "started", targetDate: date(2026, 12, 1))
        let b = Project(id: "b", name: "Alpha", status: "started")
        let c = Project(id: "c", name: "Done", status: "completed")
        let d = Project(id: "d", name: "Soon", status: "started", targetDate: date(2026, 11, 20))
        XCTAssertEqual(ProjectOrdering.sorted([c, b, a, d]).map(\.id), ["d", "a", "b", "c"])
    }
}
