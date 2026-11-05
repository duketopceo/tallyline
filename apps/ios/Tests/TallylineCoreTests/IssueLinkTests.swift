import XCTest
@testable import TallylineCore

final class IssueLinkTests: XCTestCase {
    private func issue(url: String?, blocked: Bool? = nil, key: String = "ENG-1") -> Issue {
        Issue(id: key, key: key, number: 1, title: "t", description: nil, state: .todo, priority: .none, estimate: nil, dueDate: nil,
              assigneeType: nil, assigneeId: nil, delegateType: nil, delegateId: nil, creatorType: "human", creatorId: nil,
              projectId: nil, cycleId: nil, parentId: nil, source: "app", occurrenceCount: 1,
              createdAt: Date(timeIntervalSince1970: 0), updatedAt: Date(timeIntervalSince1970: 0), blocked: blocked, url: url)
    }

    func testCopyableIsTheServerUrlExactly() {
        XCTAssertEqual(IssueLink.copyable(issue(url: "https://tallyline.app/issues/ENG-1")), "https://tallyline.app/issues/ENG-1")
    }

    func testCopyableIsHiddenWhenAbsentOrNotAWebLink() {
        XCTAssertNil(IssueLink.copyable(issue(url: nil)))
        XCTAssertNil(IssueLink.copyable(issue(url: "  ")))
        XCTAssertNil(IssueLink.copyable(issue(url: "javascript:alert(1)")))
        XCTAssertNil(IssueLink.copyable(issue(url: "ENG-1")))
    }

    func testUrlAndTeamDecodeAsOptional() throws {
        let json = #"{"id":"i","key":"ENG-1","number":1,"title":"t","state":"todo","priority":"none","creatorType":"human","source":"app","occurrenceCount":1,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}"#
        let decoder = APIClient.decoder
        let bare = try decoder.decode(Issue.self, from: Data(json.utf8))
        XCTAssertNil(bare.url)
        XCTAssertNil(bare.teamId)
        let full = json.dropLast() + #","teamId":"t1","url":"https://tallyline.app/issues/ENG-1"}"#
        let withUrl = try decoder.decode(Issue.self, from: Data(full.utf8))
        XCTAssertEqual(withUrl.teamId, "t1")
        XCTAssertEqual(IssueLink.copyable(withUrl), "https://tallyline.app/issues/ENG-1")
    }

    func testUniversalLinkRoutesToKey() {
        let u = URL(string: "https://tallyline.app/issues/eng-12?ref=x#c")!
        XCTAssertEqual(IssueLink.key(fromUniversalLink: u), "ENG-12")
    }

    func testUniversalLinkRejectsOtherHostsPathsAndSchemes() {
        XCTAssertNil(IssueLink.key(fromUniversalLink: URL(string: "https://evil.example/issues/ENG-1")!))
        XCTAssertNil(IssueLink.key(fromUniversalLink: URL(string: "http://tallyline.app/issues/ENG-1")!))
        XCTAssertNil(IssueLink.key(fromUniversalLink: URL(string: "https://tallyline.app/projects/ENG-1")!))
        XCTAssertNil(IssueLink.key(fromUniversalLink: URL(string: "https://tallyline.app/issues/ENG-1/edit")!))
        XCTAssertNil(IssueLink.key(fromUniversalLink: URL(string: "https://tallyline.app/issues/12")!))
        XCTAssertNil(IssueLink.key(fromUniversalLink: URL(string: "https://tallyline.app/issues/eng12")!))
        XCTAssertEqual(IssueLink.key(fromUniversalLink: URL(string: "https://self.example/issues/ENG-1")!, webHosts: ["self.example"]), "ENG-1")
    }

    func testNotFoundIsNamedNotACrash() {
        let missing = IssueLoadFailure.describe(APIClientError.http(404, code: "NOT_FOUND", message: "no"), key: "ENG-9")
        XCTAssertTrue(missing.isNotFound)
        XCTAssertEqual(missing.title, "ENG-9 not found")
        XCTAssertFalse(IssueLoadFailure.describe(APIClientError.transport("offline"), key: "ENG-9").isNotFound)
    }

    func testBlockedRotorIsEmptyWhenNothingIsBlocked() {
        XCTAssertTrue(BlockedIssues.filter([issue(url: nil), issue(url: nil, blocked: false, key: "ENG-2")]).isEmpty)
        let list = [issue(url: nil, blocked: true), issue(url: nil, key: "ENG-2")]
        XCTAssertEqual(BlockedIssues.filter(list).map(\.key), ["ENG-1"])
        XCTAssertEqual(BlockedIssues.keys(list), ["ENG-1"])
    }

    func testNowRotorKeepsOnlyRowsForBlockedIssues() {
        func item(_ id: String, _ key: String?) -> NowItem {
            NowItem(id: id, kind: .reviewRequest, at: Date(timeIntervalSince1970: 0), issueKey: key, sentence: id, byAgent: false)
        }
        let rows = [item("a", "ENG-1"), item("b", "ENG-2"), item("c", nil)]
        XCTAssertEqual(BlockedIssues.items(rows, blockedKeys: ["ENG-2"]).map(\.id), ["b"])
        XCTAssertTrue(BlockedIssues.items(rows, blockedKeys: []).isEmpty)
    }

    func testSnapOffsetsAndSettle() {
        let cal = Calendar(identifier: .gregorian)
        let months = (0..<6).map { cal.date(from: DateComponents(year: 2026, month: 1 + $0, day: 1))! }
        let ms = RoadmapSpan(id: "milestone:m", lane: .milestones, title: "m", start: cal.date(from: DateComponents(year: 2026, month: 4, day: 1))!, end: cal.date(from: DateComponents(year: 2026, month: 4, day: 1))!, done: nil, total: nil)
        let offsets = RoadmapSnap.offsets(spans: [ms], months: months, monthWidth: 100, inset: 16, calendar: cal)
        XCTAssertEqual(offsets, [0, 284])
        XCTAssertEqual(RoadmapSnap.settle(200, among: offsets, maxOffset: 500), 284)
        XCTAssertEqual(RoadmapSnap.settle(100, among: offsets, maxOffset: 500), 0)
        XCTAssertEqual(RoadmapSnap.settle(900, among: offsets, maxOffset: 250), 0)
    }

    func testTeamPatchEncodesAndCarriesVersionWhenSet() throws {
        func object(_ patch: IssuePatch) throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any])
        }
        let plain = try object(IssuePatch(teamId: "t2"))
        XCTAssertEqual(plain["teamId"] as? String, "t2")
        XCTAssertNil(plain["expectedVersion"])
        XCTAssertEqual(try object(IssuePatch(teamId: "t2", expectedVersion: "7"))["expectedVersion"] as? String, "7")
        XCTAssertEqual(OutboxOperation.updateIssue(key: "ENG-1", patch: IssuePatch(teamId: "t2")).summary, "ENG-1: change team")
    }

    func testTeamChangeQueuesOnePatchAndAppliesOptimistically() async throws {
        let store = MemoryOutboxStore()
        let outbox = Outbox(store: store)
        let patch = IssuePatch(teamId: "t2")
        try await outbox.enqueue(.updateIssue(key: "ENG-1", patch: patch), workspaceSlug: "w")
        let all = await outbox.all
        XCTAssertEqual(all.count, 1)
        let reloaded = try JSONDecoder().decode([OutboxEntry].self, from: JSONEncoder().encode(all))
        XCTAssertEqual(reloaded.first?.operation, .updateIssue(key: "ENG-1", patch: patch))
        XCTAssertEqual(issue(url: "https://tallyline.app/issues/ENG-1").applying(patch).teamId, "t2")
    }
}
