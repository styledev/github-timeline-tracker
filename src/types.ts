export interface Commit {
  /** Full repo name, e.g. "owner/name" */
  repo: string;
  /** ISO-8601 timestamp of the commit's author date */
  committedAt: string;
  oid: string;
  messageHeadline: string;
  url: string;
}

export interface RepoDayStats {
  repo: string;
  /** Local calendar day, "yyyy-MM-dd" */
  day: string;
  commitCount: number;
  /** Epoch ms of first and last commit that day */
  firstAt: number;
  lastAt: number;
  /** lastAt - firstAt, in ms (0 when a single commit) */
  spanMs: number;
  commits: Commit[];
}

export interface DayStats {
  day: string;
  repos: RepoDayStats[];
  totalCommits: number;
  repoCount: number;
  firstAt: number;
  lastAt: number;
  /** Wall-clock span from the day's earliest to latest commit across all repos */
  totalSpanMs: number;
  /** Sum of each repo's individual span */
  summedSpanMs: number;
}

export interface RangeSummaryStats {
  dayCount: number;
  totalCommits: number;
  repoCount: number;
  totalSpanMs: number;
  summedSpanMs: number;
}

export interface RateLimit {
  remaining: number;
  limit: number;
  resetAt: string;
}
