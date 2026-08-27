import type { RangeSummaryStats } from "../types";
import { formatDuration } from "../aggregate";

export function RangeSummary({ stats }: { stats: RangeSummaryStats }) {
  return (
    <dl className="range-summary">
      <div>
        <dt>Active days</dt>
        <dd>{stats.dayCount}</dd>
      </div>
      <div>
        <dt>Total commits</dt>
        <dd>{stats.totalCommits}</dd>
      </div>
      <div>
        <dt>Distinct repos</dt>
        <dd>{stats.repoCount}</dd>
      </div>
      <div>
        <dt title="Sum of each day's first-to-last wall-clock span">
          Total span
        </dt>
        <dd>{formatDuration(stats.totalSpanMs)}</dd>
      </div>
      <div>
        <dt title="Sum of every repo-day's own first-to-last span">
          Summed repo span
        </dt>
        <dd>{formatDuration(stats.summedSpanMs)}</dd>
      </div>
    </dl>
  );
}
