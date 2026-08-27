import { describe, expect, it } from "vitest";
import { aggregate, dayFraction, formatDuration, summarizeRange } from "./aggregate";
import type { Commit } from "./types";

/** Build a commit at a local wall-clock time so tests are timezone-independent. */
function commit(
  repo: string,
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
): Commit {
  const at = new Date(y, m - 1, d, hh, mm, 0, 0);
  return {
    repo,
    committedAt: at.toISOString(),
    oid: `${repo}-${at.getTime()}`,
    messageHeadline: "test",
    url: "https://example.com",
  };
}

describe("aggregate", () => {
  it("returns nothing for no commits", () => {
    expect(aggregate([])).toEqual([]);
  });

  it("groups commits by local day and repo", () => {
    const days = aggregate([
      commit("me/a", 2026, 3, 2, 9, 0),
      commit("me/a", 2026, 3, 2, 17, 30),
      commit("me/b", 2026, 3, 2, 12, 0),
      commit("me/a", 2026, 3, 3, 8, 0),
    ]);

    expect(days.map((d) => d.day)).toEqual(["2026-03-02", "2026-03-03"]);
    expect(days[0].repoCount).toBe(2);
    expect(days[0].totalCommits).toBe(3);
    expect(days[1].repoCount).toBe(1);
  });

  it("computes per-repo span from first to last commit", () => {
    const [day] = aggregate([
      commit("me/a", 2026, 3, 2, 17, 30),
      commit("me/a", 2026, 3, 2, 9, 0),
    ]);
    const repo = day.repos[0];
    expect(repo.commitCount).toBe(2);
    expect(repo.spanMs).toBe(8.5 * 3_600_000);
  });

  it("reports a zero span for a single commit", () => {
    const [day] = aggregate([commit("me/a", 2026, 3, 2, 9, 0)]);
    expect(day.repos[0].spanMs).toBe(0);
    expect(day.totalSpanMs).toBe(0);
  });

  it("distinguishes total span from summed repo spans", () => {
    const [day] = aggregate([
      commit("me/a", 2026, 3, 2, 9, 0),
      commit("me/a", 2026, 3, 2, 10, 0),
      commit("me/b", 2026, 3, 2, 14, 0),
      commit("me/b", 2026, 3, 2, 15, 0),
    ]);
    // 09:00 -> 15:00 wall clock
    expect(day.totalSpanMs).toBe(6 * 3_600_000);
    // 1h in each repo
    expect(day.summedSpanMs).toBe(2 * 3_600_000);
  });

  it("orders repos within a day by first commit", () => {
    const [day] = aggregate([
      commit("me/z", 2026, 3, 2, 8, 0),
      commit("me/a", 2026, 3, 2, 13, 0),
    ]);
    expect(day.repos.map((r) => r.repo)).toEqual(["me/z", "me/a"]);
  });

  it("ignores commits with unparseable timestamps", () => {
    const bad: Commit = { ...commit("me/a", 2026, 3, 2, 9, 0), committedAt: "nope" };
    expect(aggregate([bad])).toEqual([]);
  });
});

describe("summarizeRange", () => {
  it("aggregates totals and distinct repos across days", () => {
    const stats = summarizeRange(
      aggregate([
        commit("me/a", 2026, 3, 2, 9, 0),
        commit("me/a", 2026, 3, 2, 11, 0),
        commit("me/b", 2026, 3, 3, 9, 0),
        commit("me/a", 2026, 3, 3, 12, 0),
      ]),
    );
    expect(stats.dayCount).toBe(2);
    expect(stats.totalCommits).toBe(4);
    expect(stats.repoCount).toBe(2);
    expect(stats.totalSpanMs).toBe(5 * 3_600_000);
    expect(stats.summedSpanMs).toBe(2 * 3_600_000);
  });

  it("handles an empty range", () => {
    expect(summarizeRange([])).toEqual({
      dayCount: 0,
      totalCommits: 0,
      repoCount: 0,
      totalSpanMs: 0,
      summedSpanMs: 0,
    });
  });
});

describe("dayFraction", () => {
  it("maps local midnight to 0 and noon to 0.5", () => {
    expect(dayFraction(new Date(2026, 2, 2, 0, 0).getTime())).toBe(0);
    expect(dayFraction(new Date(2026, 2, 2, 12, 0).getTime())).toBe(0.5);
  });
});

describe("formatDuration", () => {
  it("formats hours and minutes", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(45 * 60_000)).toBe("45m");
    expect(formatDuration(2 * 3_600_000)).toBe("2h");
    expect(formatDuration(2 * 3_600_000 + 15 * 60_000)).toBe("2h 15m");
  });
});
