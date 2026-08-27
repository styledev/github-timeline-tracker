import type {
  Commit,
  DayStats,
  RangeSummaryStats,
  RepoDayStats,
} from "./types";

/** Local-timezone calendar day key, "yyyy-MM-dd". */
export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Fraction of the local day elapsed at `ms`, in [0, 1]. */
export function dayFraction(ms: number): number {
  const d = new Date(ms);
  const startOfDay = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
  ).getTime();
  return (ms - startOfDay) / 86_400_000;
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "0m";
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function buildRepoDayStats(day: string, repo: string, commits: Commit[]): RepoDayStats {
  const sorted = [...commits].sort(
    (a, b) =>
      new Date(a.committedAt).getTime() - new Date(b.committedAt).getTime(),
  );
  const firstAt = new Date(sorted[0].committedAt).getTime();
  const lastAt = new Date(sorted[sorted.length - 1].committedAt).getTime();
  return {
    repo,
    day,
    commitCount: sorted.length,
    firstAt,
    lastAt,
    spanMs: lastAt - firstAt,
    commits: sorted,
  };
}

/**
 * Group commits into per-day, per-repo buckets using the browser's local
 * timezone for day boundaries. Days are returned in ascending order and repos
 * within a day are ordered by their first commit.
 */
export function aggregate(commits: Commit[]): DayStats[] {
  const byDay = new Map<string, Map<string, Commit[]>>();

  for (const commit of commits) {
    const at = new Date(commit.committedAt);
    if (Number.isNaN(at.getTime())) continue;
    const day = dayKey(at);
    let repos = byDay.get(day);
    if (!repos) {
      repos = new Map();
      byDay.set(day, repos);
    }
    const bucket = repos.get(commit.repo);
    if (bucket) bucket.push(commit);
    else repos.set(commit.repo, [commit]);
  }

  const days: DayStats[] = [];
  for (const [day, repoMap] of byDay) {
    const repos = [...repoMap.entries()]
      .map(([repo, list]) => buildRepoDayStats(day, repo, list))
      .sort((a, b) => a.firstAt - b.firstAt || a.repo.localeCompare(b.repo));

    const firstAt = Math.min(...repos.map((r) => r.firstAt));
    const lastAt = Math.max(...repos.map((r) => r.lastAt));
    days.push({
      day,
      repos,
      totalCommits: repos.reduce((sum, r) => sum + r.commitCount, 0),
      repoCount: repos.length,
      firstAt,
      lastAt,
      totalSpanMs: lastAt - firstAt,
      summedSpanMs: repos.reduce((sum, r) => sum + r.spanMs, 0),
    });
  }

  return days.sort((a, b) => a.day.localeCompare(b.day));
}

export function summarizeRange(days: DayStats[]): RangeSummaryStats {
  const repos = new Set<string>();
  for (const day of days) for (const r of day.repos) repos.add(r.repo);
  return {
    dayCount: days.length,
    totalCommits: days.reduce((sum, d) => sum + d.totalCommits, 0),
    repoCount: repos.size,
    totalSpanMs: days.reduce((sum, d) => sum + d.totalSpanMs, 0),
    summedSpanMs: days.reduce((sum, d) => sum + d.summedSpanMs, 0),
  };
}

const PALETTE = [
  "#3b82f6",
  "#ef4444",
  "#22c55e",
  "#a855f7",
  "#f59e0b",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
  "#8b5cf6",
  "#f97316",
];

/** Stable per-repo color derived from the repo name. */
export function repoColor(repo: string): string {
  let hash = 0;
  for (let i = 0; i < repo.length; i++) {
    hash = (hash * 31 + repo.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
