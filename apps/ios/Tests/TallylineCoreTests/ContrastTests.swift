import XCTest
@testable import TallylineCore

/// The iOS app's text colours against the DESIGN.md contrast floors
/// (docs/design/silver-lining.md section 3): 4.5:1 for body text, 3:1 for
/// large text, UI glyphs and meaningful graphics.
final class ContrastTests: XCTestCase {
    private let palettes: [(String, SilverLiningPalette)] = [
        ("light", SilverLiningTokens.light),
        ("dark", SilverLiningTokens.dark),
        ("hc-dark", SilverLiningTokens.hcDark),
    ]

    private func ratio(_ fg: String, _ bg: String) throws -> Double {
        let a = try XCTUnwrap(SilverLiningRGBA.parse(fg), fg)
        let b = try XCTUnwrap(SilverLiningRGBA.parse(bg), bg)
        return Contrast.ratio(a, b)
    }

    func testRatioMatchesTheWCAGExtremes() {
        let black = SilverLiningRGBA(red: 0, green: 0, blue: 0)
        let white = SilverLiningRGBA(red: 1, green: 1, blue: 1)
        XCTAssertEqual(Contrast.ratio(black, white), 21, accuracy: 0.01)
        XCTAssertEqual(Contrast.ratio(white, white), 1, accuracy: 0.01)
    }

    func testBodyTextMeetsFourPointFive() throws {
        for (name, p) in palettes {
            for (token, fg) in [("ink", p.ink), ("ink-muted", p.inkMuted), ("ink-subtle", p.inkSubtle), ("status-urgent", p.statusUrgent)] {
                for (surface, bg) in [("canvas", p.canvas), ("surface-1", p.surface1)] {
                    let r = try ratio(fg, bg)
                    XCTAssertGreaterThanOrEqual(r, 4.5, "\(name) \(token) on \(surface) is \(r)")
                }
            }
        }
    }

    func testAccentAndStatusGlyphsMeetThree() throws {
        for (name, p) in palettes {
            for (token, fg) in [("accent", p.accent), ("status-attention", p.statusAttention), ("status-healthy", p.statusHealthy), ("glint", p.glint)] {
                let r = try ratio(fg, p.canvas)
                XCTAssertGreaterThanOrEqual(r, 3, "\(name) \(token) on canvas is \(r)")
            }
            let label = try ratio(p.onAccent, p.accent)
            XCTAssertGreaterThanOrEqual(label, 4.5, "\(name) on-accent on accent is \(label)")
        }
    }
}

final class IssueSpeechTests: XCTestCase {
    private func issue(priority: IssuePriority, creator: String, occurrences: Int) -> Issue {
        Issue(
            id: "1", key: "ENG-12", number: 12, title: "Fix the banner", description: nil,
            state: .inProgress, priority: priority, estimate: nil, dueDate: nil,
            assigneeType: nil, assigneeId: nil, delegateType: nil, delegateId: nil,
            creatorType: creator, creatorId: nil, projectId: nil, cycleId: nil, parentId: nil,
            source: "app", occurrenceCount: occurrences,
            createdAt: Date(timeIntervalSince1970: 0), updatedAt: Date(timeIntervalSince1970: 0)
        )
    }

    func testReadsKeyTitleStateThenExtras() {
        XCTAssertEqual(IssueSpeech.label(issue(priority: .urgent, creator: "agent", occurrences: 3)),
                       "ENG-12, Fix the banner, In progress, Urgent priority, Created by an agent, Reported 3 times")
        XCTAssertEqual(IssueSpeech.label(issue(priority: .none, creator: "human", occurrences: 1)),
                       "ENG-12, Fix the banner, In progress")
    }

    func testEveryStateAndPriorityHasAName() {
        XCTAssertEqual(IssueState.allCases.map(\.displayName).filter { $0.contains("_") }, [])
        XCTAssertEqual(Set(IssuePriority.allCases.map(\.displayName)).count, IssuePriority.allCases.count)
    }
}
