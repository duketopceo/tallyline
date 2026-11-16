import XCTest
@testable import TallylineCore

final class HomeOverviewTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func merge(id: String, key: String, projectId: String?, at: TimeInterval, agent: Bool = true, pr: Int? = nil, name: String = "Builder") throws -> RoadmapSummary.Merge {
        let prJSON = pr.map { #","pr":{"number":\#($0),"url":"https://example.com/p","title":null,"repo":null}"# } ?? ""
        let project = projectId.map { "\"\($0)\"" } ?? "null"
        let json = #"{"id":"\#(id)","issueKey":"\#(key)","issueTitle":"t","projectId":\#(project),"actorName":"\#(name)","actorType":"\#(agent ? "agent" : "human")","at":"\#(APIDate.format(now.addingTimeInterval(at)))"\#(prJSON)}"#
        return try APIClient.decoder.decode(RoadmapSummary.Merge.self, from: Data(json.utf8))
    }

    private func counts(id: String, total: Int, done: Int, closed: Int = 0, inProgress: Int = 0, inReview: Int = 0) throws -> RoadmapSummary.ProjectCounts {
        let json = #"{"projectId":"\#(id)","total":\#(total),"done":\#(done),"closed":\#(closed),"inProgress":\#(inProgress),"inReview":\#(inReview),"doneSince":null}"#
        return try APIClient.decoder.decode(RoadmapSummary.ProjectCounts.self, from: Data(json.utf8))
    }

    private func summary(counts: [RoadmapSummary.ProjectCounts], merges: [RoadmapSummary.Merge]) throws -> RoadmapSummary {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, enc in
            var container = enc.singleValueContainer()
            try container.encode(APIDate.format(date))
        }
        let countsJSON = String(data: try encoder.encode(counts), encoding: .utf8)!
        let mergesJSON = String(data: try encoder.encode(merges), encoding: .utf8)!
        let json = #"{"generatedAt":"\#(APIDate.format(now))","since":"\#(APIDate.format(now.addingTimeInterval(-7 * 86_400)))","totals":{"issues":0,"done":0,"closed":0,"doneSince":0},"projects":\#(countsJSON),"milestones":[],"merges":\#(mergesJSON)}"#
        return try APIClient.decoder.decode(RoadmapSummary.self, from: Data(json.utf8))
    }

    private func issue(_ id: String, key: String, title: String, state: IssueState, type: String?, agent: String?, updated: TimeInterval, project: String? = "p") -> Issue {
        Issue(
            id: id, key: key, number: 1, title: title, description: nil, state: state, priority: .none,
            estimate: nil, dueDate: nil, assigneeType: type, assigneeId: agent, delegateType: nil, delegateId: nil,
            creatorType: "human", creatorId: nil, projectId: project, cycleId: nil, parentId: nil, source: "web",
            occurrenceCount: 1, createdAt: now.addingTimeInterval(-1_000), updatedAt: now.addingTimeInterval(updated)
        )
    }

    func testOrdersActiveProjectsByMostRecentActivityThenName() throws {
        let kate = Project(id: "k", name: "Kate", status: "started")
        let cairn = Project(id: "c", name: "Cairn", status: "started")
        let idle = Project(id: "i", name: "Idle", status: "planned")
        let done = Project(id: "d", name: "Done", status: "completed")
        let canceled = Project(id: "x", name: "Dropped", status: "canceled")
        let summary = try summary(
            counts: [
                try counts(id: "k", total: 10, done: 4, inProgress: 2, inReview: 1),
                try counts(id: "c", total: 5, done: 1, closed: 1, inProgress: 1),
                try counts(id: "i", total: 0, done: 0),
            ],
            merges: [
                try merge(id: "m1", key: "KATE-1", projectId: "k", at: -200),
                try merge(id: "m2", key: "CAIRN-9", projectId: "c", at: -50, pr: 12),
                try merge(id: "m3", key: "KATE-2", projectId: "k", at: -400),
            ]
        )
        let cards = HomeOverview.cards(projects: [idle, done, kate, canceled, cairn], summary: summary, fetchedAt: now, now: now)
        XCTAssertEqual(cards.map(\.id), ["c", "k", "i"])
        XCTAssertEqual(cards[0].lastActivity?.sentence, "Builder merged #12 for CAIRN-9")
        XCTAssertEqual(cards[1].lastActivity?.sentence, "Builder finished KATE-1")
        XCTAssertNil(cards[2].lastActivity)
        XCTAssertEqual(cards[0].openCount, 3) // 5 - 1 done - 1 closed
        XCTAssertEqual(cards[1].openCount, 6) // 10 - 4
        XCTAssertEqual(cards[1].inProgress, 2)
        XCTAssertEqual(cards[1].inReview, 1)
        XCTAssertEqual(cards[0].fraction, 0.2)
    }

    func testEmptyStateWhenNoActiveProjects() {
        let done = Project(id: "d", name: "Done", status: "completed")
        XCTAssertEqual(HomeOverview.cards(projects: [done], summary: nil, fetchedAt: now, now: now), [])
        XCTAssertEqual(HomeOverview.cards(projects: [], summary: nil, fetchedAt: nil, now: now), [])
    }

    func testActivityLineMarksStaleDataAndNeverInventsFreshness() throws {
        let project = Project(id: "k", name: "Kate", status: "started")
        let summary = try summary(
            counts: [try counts(id: "k", total: 2, done: 1)],
            merges: [try merge(id: "m", key: "KATE-1", projectId: "k", at: -700)]
        )
        let stale = HomeOverview.cards(projects: [project], summary: summary, fetchedAt: now.addingTimeInterval(-600), now: now)
        XCTAssertEqual(stale[0].lastActivity?.asOf, now.addingTimeInterval(-600))
        XCTAssertEqual(stale[0].lastActivity?.displayText(date: { _ in "3:01 PM" }), "Builder finished KATE-1 · as of 3:01 PM")
        XCTAssertTrue(stale[0].accessibilityLabel(date: { _ in "3:01 PM" }).contains("as of 3:01 PM"))

        let fresh = HomeOverview.cards(projects: [project], summary: summary, fetchedAt: now.addingTimeInterval(-60), now: now)
        XCTAssertNil(fresh[0].lastActivity?.asOf)
        XCTAssertEqual(fresh[0].lastActivity?.displayText(date: { _ in "3:01 PM" }), "Builder finished KATE-1")
        XCTAssertFalse(fresh[0].accessibilityLabel(date: { _ in "3:01 PM" }).contains("as of"))
    }

    func testOrphanMergesDoNotAttachAndMissingSummaryReadsAsZero() throws {
        let project = Project(id: "k", name: "Kate", status: "started")
        let summary = try summary(
            counts: [],
            merges: [try merge(id: "m", key: "OTHER-1", projectId: nil, at: -10)]
        )
        let cards = HomeOverview.cards(projects: [project], summary: summary, fetchedAt: now, now: now)
        XCTAssertNil(cards[0].lastActivity)
        XCTAssertEqual(cards[0].openCount, 0)
        XCTAssertEqual(cards[0].total, 0)
        XCTAssertEqual(HomeOverview.cards(projects: [project], summary: nil, fetchedAt: now, now: now)[0].total, 0)
    }

    func testLatestMergeWinsWhenAnOlderOneFollowsInTheArray() throws {
        let project = Project(id: "k", name: "Kate", status: "started")
        let summary = try summary(
            counts: [try counts(id: "k", total: 3, done: 1, closed: 4)],
            merges: [
                try merge(id: "new", key: "KATE-2", projectId: "k", at: -10, name: "Builder"),
                try merge(id: "old", key: "KATE-1", projectId: "k", at: -400, name: "Earlier"),
            ]
        )
        let cards = HomeOverview.cards(projects: [project], summary: summary, fetchedAt: now, now: now)
        XCTAssertEqual(cards[0].lastActivity?.sentence, "Builder finished KATE-2")
        XCTAssertEqual(cards[0].openCount, 0, "openCount floors at zero when closed + done exceed total")
    }

    func testWorkingStripIsOneIssuePerAgentWithoutInventedNames() {
        let rows = [
            issue("1", key: "ENG-1", title: "Wire home", state: .inProgress, type: "agent", agent: "a", updated: -10),
            issue("2", key: "ENG-2", title: "Older task", state: .inProgress, type: "agent", agent: "a", updated: -100),
            issue("3", key: "ENG-3", title: "Review copy", state: .inProgress, type: "agent", agent: "b", updated: -20),
            issue("4", key: "ENG-4", title: "Todo", state: .todo, type: "agent", agent: "c", updated: -1),
            issue("5", key: "ENG-5", title: "Human", state: .inProgress, type: "human", agent: "u", updated: -1),
        ]
        let items = HomeOverview.workingAgents(in: rows)
        XCTAssertEqual(items.map(\.agentId), ["a", "b"])
        XCTAssertEqual(items.map(\.issueKey), ["ENG-1", "ENG-3"])
        XCTAssertEqual(items[0].line, "ENG-1 · Wire home")
        XCTAssertFalse(items[0].line.lowercased().contains("agent a"))
    }

    func testHomeViewDeclaresAnAX5Preview() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/tallyline_ios/Home/HomeView.swift")
        let text = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(text.contains(".dynamicTypeSize(.accessibility5)"), "Home cards need an AX5 preview so clipping is visible in the catalog")
        XCTAssertTrue(text.contains("accessibilityLabel"), "The card must expose a one-sentence VoiceOver label")
    }
}
