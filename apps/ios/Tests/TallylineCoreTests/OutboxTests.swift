import Foundation
import XCTest
@testable import TallylineCore

/// Test clock, advanced by hand.
final class ManualClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_800_000_000)
    var now: Date { lock.lock(); defer { lock.unlock() }; return current }
    func advance(_ seconds: TimeInterval) { lock.lock(); current += seconds; lock.unlock() }
}

final class MemoryOutboxStore: OutboxStore, @unchecked Sendable {
    var saved: [OutboxEntry] = []
    func load() throws -> [OutboxEntry] { saved }
    func save(_ entries: [OutboxEntry]) throws { saved = entries }
}

/// Fake server: records sends; fails per a script, keyed by entry id.
final class ScriptedSender: OutboxSender, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var sent: [String] = []
    /// Idempotency keys the "server" has applied. A replay must not apply twice.
    private(set) var applied: [String] = []
    var failures: [String: [Error]] = [:]
    /// Simulates a lost response: the write lands, the reply never arrives.
    var dropResponseOnce: Set<String> = []

    func send(_ entry: OutboxEntry) async throws {
        try lock.withLock { try record(entry) }
    }

    private func record(_ entry: OutboxEntry) throws {
        sent.append(entry.id)
        if var queue = failures[entry.id], !queue.isEmpty {
            let error = queue.removeFirst()
            failures[entry.id] = queue
            throw error
        }
        if !applied.contains(entry.id) { applied.append(entry.id) }
        if dropResponseOnce.remove(entry.id) != nil {
            throw APIClientError.transport("connection lost")
        }
    }
}

final class OutboxTests: XCTestCase {
    private let offline = APIClientError.transport("offline")

    private func makeOutbox(_ store: MemoryOutboxStore = MemoryOutboxStore(), clock: ManualClock) -> Outbox {
        Outbox(store: store, now: { clock.now })
    }

    func testBackoffDoublesToFiveMinutes() {
        let p = OutboxPolicy()
        XCTAssertEqual((1...10).map { p.delay(afterAttempt: $0) }, [1, 2, 4, 8, 16, 32, 64, 128, 256, 300])
    }

    func testSendsAndRemoves() async throws {
        let clock = ManualClock()
        let store = MemoryOutboxStore()
        let outbox = makeOutbox(store, clock: clock)
        let entry = try await outbox.enqueue(.addComment(key: "ENG-1", body: "hi"), workspaceSlug: "acme")
        XCTAssertEqual(store.saved.count, 1, "persisted before send")
        let sender = ScriptedSender()
        let result = await outbox.drain(using: sender)
        XCTAssertEqual(result.sent, [entry.id])
        let remaining = await outbox.all
        XCTAssertTrue(remaining.isEmpty)
        XCTAssertTrue(store.saved.isEmpty)
    }

    func testAirplaneModeRetriesWithBackoffThenParks() async throws {
        let clock = ManualClock()
        let outbox = makeOutbox(clock: clock)
        let entry = try await outbox.enqueue(.createIssue(IssueCreate(title: "x", teamId: "t")), workspaceSlug: "acme")
        let sender = ScriptedSender()
        sender.failures[entry.id] = Array(repeating: offline, count: 8)

        for attempt in 1...7 {
            let r = await outbox.drain(using: sender)
            XCTAssertEqual(r.retrying, [entry.id], "attempt \(attempt)")
            let notYet = await outbox.drain(using: sender)
            XCTAssertEqual(notYet, DrainResult(), "waits out the backoff")
            clock.advance(OutboxPolicy().delay(afterAttempt: attempt))
        }
        let last = await outbox.drain(using: sender)
        XCTAssertEqual(last.failed, [entry.id])
        let parked = await outbox.all.first
        guard case .failed(let reason)? = parked?.status else { return XCTFail("not parked") }
        XCTAssertTrue(reason.contains("8 tries"))
        XCTAssertEqual(sender.sent.count, 8)

        // Retry brings it back; the network is up now.
        try await outbox.retry(entry.id)
        let again = await outbox.drain(using: sender)
        XCTAssertEqual(again.sent, [entry.id])
    }

    func testLostResponseReplaysWithSameKeyAndAppliesOnce() async throws {
        let clock = ManualClock()
        let outbox = makeOutbox(clock: clock)
        let entry = try await outbox.enqueue(.addComment(key: "ENG-1", body: "once"), workspaceSlug: "acme")
        let sender = ScriptedSender()
        sender.dropResponseOnce = [entry.id]
        _ = await outbox.drain(using: sender)
        clock.advance(1)
        _ = await outbox.drain(using: sender)
        XCTAssertEqual(sender.sent, [entry.id, entry.id], "same idempotency key on replay")
        XCTAssertEqual(sender.applied, [entry.id], "server applied it once")
    }

    func testPerIssueOrderingBlocksBehindAFailure() async throws {
        let clock = ManualClock()
        let outbox = makeOutbox(clock: clock)
        let first = try await outbox.enqueue(.updateIssue(key: "ENG-1", patch: IssuePatch(state: .inProgress)), workspaceSlug: "acme")
        let second = try await outbox.enqueue(.addComment(key: "ENG-1", body: "started"), workspaceSlug: "acme")
        let other = try await outbox.enqueue(.addComment(key: "ENG-2", body: "independent"), workspaceSlug: "acme")
        let sender = ScriptedSender()
        sender.failures[first.id] = [offline]

        let r = await outbox.drain(using: sender)
        XCTAssertEqual(r.retrying, [first.id])
        XCTAssertEqual(r.sent, [other.id], "other issues are not held up")
        XCTAssertFalse(sender.sent.contains(second.id), "never overtakes an earlier write to the same issue")

        clock.advance(1)
        let r2 = await outbox.drain(using: sender)
        XCTAssertEqual(r2.sent, [first.id, second.id], "in order once unblocked")
    }

    func testCanceledIssueConflictParksWithServerReason() async throws {
        // AE3: the issue was cancelled elsewhere; the server state machine wins.
        let clock = ManualClock()
        let outbox = makeOutbox(clock: clock)
        let entry = try await outbox.enqueue(.updateIssue(key: "ENG-9", patch: IssuePatch(state: .inReview)), workspaceSlug: "acme")
        let sender = ScriptedSender()
        sender.failures[entry.id] = [APIClientError.http(422, code: "INVALID_TRANSITION", message: "ENG-9 is canceled")]
        let r = await outbox.drain(using: sender)
        XCTAssertEqual(r.failed, [entry.id])
        let parked = await outbox.all.first
        XCTAssertEqual(parked?.status, .failed(reason: "ENG-9 is canceled"))
        XCTAssertEqual(sender.sent.count, 1, "no blind retries of a rejected write")

        try await outbox.discard(entry.id)
        let empty = await outbox.all
        XCTAssertTrue(empty.isEmpty)
    }

    func testClassification() {
        XCTAssertEqual(OutboxFailure.classify(APIClientError.http(503, code: nil, message: nil)), .retryable("HTTP 503"))
        XCTAssertEqual(OutboxFailure.classify(APIClientError.http(409, code: nil, message: "in flight")), .retryable("in flight"))
        XCTAssertEqual(OutboxFailure.classify(APIClientError.http(429, code: nil, message: nil)), .retryable("HTTP 429"))
        XCTAssertEqual(OutboxFailure.classify(APIClientError.http(401, code: nil, message: "revoked")), .rejected("revoked"))
    }

    func testSignOutWipesQueueAndSurvivesRelaunch() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = JSONFileStore<[OutboxEntry]>.standard(named: "outbox", in: dir)
        let clock = ManualClock()
        let outbox = Outbox(store: store, now: { clock.now })
        let entry = try await outbox.enqueue(.addComment(key: "ENG-1", body: "persist me"), workspaceSlug: "acme")

        let relaunched = Outbox(store: store, now: { clock.now })
        let restored = await relaunched.all
        XCTAssertEqual(restored, [entry])

        try await relaunched.wipe()
        XCTAssertEqual(try store.load(), [])
    }
}

/// Fake server for the write contract: one current version per issue key; an
/// edit whose `baseVersion` is behind it is a STALE_WRITE.
final class VersionedSender: VersionReportingSender, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var sent: [String] = []
    var versions: [String: Int]

    init(versions: [String: Int]) { self.versions = versions }

    func send(_ entry: OutboxEntry) async throws { _ = try await sendReportingVersion(entry) }

    func sendReportingVersion(_ entry: OutboxEntry) async throws -> Int? {
        try lock.withLock {
            sent.append(entry.id)
            guard case .updateIssue(let key, _) = entry.operation else { return nil }
            let current = versions[key] ?? 1
            if let base = entry.baseVersion, base != current {
                throw APIClientError.staleWrite(message: "\(key) changed elsewhere", currentVersion: current)
            }
            versions[key] = current + 1
            return current + 1
        }
    }
}

final class WriteContractOutboxTests: XCTestCase {
    private func makeOutbox(clock: ManualClock) -> Outbox { Outbox(store: MemoryOutboxStore(), now: { clock.now }) }
    private func edit(_ key: String = "ENG-1") -> OutboxOperation { .updateIssue(key: key, patch: IssuePatch(priority: .high)) }

    func testClassifierParksStaleWriteButKeepsInFlightRetryable() {
        XCTAssertEqual(
            OutboxFailure.classify(APIClientError.staleWrite(message: "changed", currentVersion: 7)),
            .conflict("changed", serverVersion: 7)
        )
        XCTAssertEqual(
            OutboxFailure.classify(APIClientError.http(409, code: "STALE_WRITE", message: "changed")),
            .conflict("changed", serverVersion: nil)
        )
        XCTAssertEqual(
            OutboxFailure.classify(APIClientError.http(409, code: "IDEMPOTENCY_IN_PROGRESS", message: "still running")),
            .retryable("still running")
        )
    }

    func testInFlightIdempotency409IsRetriedNotParked() async throws {
        let clock = ManualClock()
        let outbox = makeOutbox(clock: clock)
        let entry = try await outbox.enqueue(edit(), workspaceSlug: "acme", baseVersion: 3)
        let sender = ScriptedSender()
        sender.failures[entry.id] = [APIClientError.http(409, code: "IDEMPOTENCY_IN_PROGRESS", message: "retry shortly")]
        let r = await outbox.drain(using: sender)
        XCTAssertEqual(r.retrying, [entry.id])
        XCTAssertEqual(r.failed, [])
        clock.advance(1)
        let r2 = await outbox.drain(using: sender)
        XCTAssertEqual(r2.sent, [entry.id])
    }

    func testStaleWriteParksAsNeedsDecisionAndIsNeverRetried() async throws {
        let clock = ManualClock()
        let outbox = makeOutbox(clock: clock)
        let entry = try await outbox.enqueue(edit(), workspaceSlug: "acme", baseVersion: 3)
        let sender = VersionedSender(versions: ["ENG-1": 5])
        let r = await outbox.drain(using: sender)
        XCTAssertEqual(r.failed, [entry.id])
        let parked = await outbox.all.first
        XCTAssertEqual(parked?.status, .needsDecision(reason: "ENG-1 changed elsewhere", serverVersion: 5))
        XCTAssertEqual(parked?.displayState, .parked)
        XCTAssertEqual(parked?.needsDecision, true)
        clock.advance(3_600)
        let again = await outbox.drain(using: sender)
        XCTAssertEqual(again, DrainResult(), "parked, not retried silently")
        XCTAssertEqual(sender.sent.count, 1)
    }

    func testUseTheirsDropsTheLocalPatch() async throws {
        let outbox = makeOutbox(clock: ManualClock())
        let entry = try await outbox.enqueue(edit(), workspaceSlug: "acme", baseVersion: 3)
        let sender = VersionedSender(versions: ["ENG-1": 5])
        _ = await outbox.drain(using: sender)
        try await outbox.useTheirs(entry.id)
        let left = await outbox.all
        XCTAssertTrue(left.isEmpty)
        XCTAssertEqual(sender.versions["ENG-1"], 5, "server state untouched")
    }

    func testKeepMineResendsAgainstTheServerVersion() async throws {
        let clock = ManualClock()
        let outbox = makeOutbox(clock: clock)
        let entry = try await outbox.enqueue(edit(), workspaceSlug: "acme", baseVersion: 3)
        let sender = VersionedSender(versions: ["ENG-1": 5])
        _ = await outbox.drain(using: sender)
        try await outbox.keepMine(entry.id)
        let r = await outbox.drain(using: sender)
        XCTAssertEqual(r.sent, [entry.id])
        XCTAssertEqual(sender.versions["ENG-1"], 6)
    }

    func testTwoQueuedEditsResolveInOrderWithoutAFalseConflict() async throws {
        let outbox = makeOutbox(clock: ManualClock())
        let first = try await outbox.enqueue(edit(), workspaceSlug: "acme", baseVersion: 3)
        let second = try await outbox.enqueue(.updateIssue(key: "ENG-1", patch: IssuePatch(title: "t")), workspaceSlug: "acme", baseVersion: 3)
        let sender = VersionedSender(versions: ["ENG-1": 3])
        let r = await outbox.drain(using: sender)
        XCTAssertEqual(r.sent, [first.id, second.id])
        XCTAssertEqual(r.failed, [])
        XCTAssertEqual(sender.versions["ENG-1"], 5)
    }

    func testEntryWithoutBaseVersionSendsNoPrecondition() async throws {
        let outbox = makeOutbox(clock: ManualClock())
        let entry = try await outbox.enqueue(edit(), workspaceSlug: "acme")
        XCTAssertNil(entry.baseVersion)
        let sender = VersionedSender(versions: ["ENG-1": 9])
        let r = await outbox.drain(using: sender)
        XCTAssertEqual(r.sent, [entry.id])
    }

    func testEntryPersistedBeforeTheContractStillDecodes() throws {
        let json = """
        {"id":"a","workspaceSlug":"w","operation":{"addComment":{"key":"ENG-1","body":"x"}},"orderingKey":"issue:ENG-1",\
        "createdAt":0,"attempts":0,"nextAttemptAt":0,"status":{"pending":{}}}
        """
        let entry = try JSONDecoder().decode(OutboxEntry.self, from: Data(json.utf8))
        XCTAssertNil(entry.baseVersion)
        XCTAssertEqual(entry.displayState, .pending)
    }
}

final class IssueCacheTests: XCTestCase {
    private func issue(_ id: String, title: String, state: IssueState = .todo, updated: TimeInterval) -> Issue {
        Issue(
            id: id, key: "ENG-\(id)", number: Int(id) ?? 0, title: title, description: nil,
            state: state, priority: .none, estimate: nil, dueDate: nil,
            assigneeType: nil, assigneeId: nil, delegateType: nil, delegateId: nil,
            creatorType: "human", creatorId: nil, projectId: nil, cycleId: nil, parentId: nil,
            source: "app", occurrenceCount: 1,
            createdAt: Date(timeIntervalSince1970: 0), updatedAt: Date(timeIntervalSince1970: updated)
        )
    }

    func testDeltaMergeNewerWins() {
        var cache = IssueCacheSnapshot(workspaceSlug: "acme", issues: [issue("1", title: "old", updated: 10)])
        cache.merge([issue("1", title: "stale", updated: 5), issue("2", title: "new", state: .triage, updated: 20)], syncedAt: Date(timeIntervalSince1970: 30))
        XCTAssertEqual(cache.issues.map(\.title), ["new", "old"])
        XCTAssertEqual(cache.issues(in: .triage).map(\.id), ["2"])
        cache.merge([issue("1", title: "fresh", updated: 40)], syncedAt: Date(timeIntervalSince1970: 50))
        XCTAssertEqual(cache.issues.first?.title, "fresh")
        XCTAssertEqual(cache.syncedAt, Date(timeIntervalSince1970: 50))
    }

    func testCacheRoundTripsThroughFile() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = JSONFileStore<IssueCacheSnapshot>.standard(named: "cache", in: dir)
        let snap = IssueCacheSnapshot(workspaceSlug: "acme", issues: [issue("1", title: "a", updated: 10)], syncedAt: Date(timeIntervalSince1970: 10))
        try store.write(snap)
        XCTAssertEqual(try store.read(), snap)
        try store.delete()
        XCTAssertNil(try store.read())
    }
}

final class OptimisticPatchTests: XCTestCase {
    func testApplyingPatchKeepsUntouchedFields() throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/issue_detail.json"))
        let issue = try APIClient.decoder.decode(Issue.self, from: data)
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let moved = issue.applying(IssuePatch(state: .done), at: now)
        XCTAssertEqual(moved.state, .done)
        XCTAssertEqual(moved.priority, issue.priority)
        XCTAssertEqual(moved.title, issue.title)
        XCTAssertEqual(moved.updatedAt, now)
    }
}
