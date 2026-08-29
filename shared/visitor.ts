/**
 * Anonymous reader-presence windows shared by the server and tests.
 *
 * A visitor is represented by a first-party cookie, not an IP address or a
 * personal identifier. "Live" means seen during the last two minutes; the
 * longer window counts distinct visitor sessions seen during the last day.
 */

export const LIVE_VISITOR_WINDOW_SECONDS = 2 * 60;
export const VISITOR_24H_WINDOW_SECONDS = 24 * 60 * 60;

export interface VisitorStats {
  liveVisitors: number;
  visitors24h: number;
}

export function countVisitorPresence(
  lastSeenAtMs: readonly number[],
  nowMs: number
): VisitorStats {
  const liveCutoff = nowMs - LIVE_VISITOR_WINDOW_SECONDS * 1000;
  const dayCutoff = nowMs - VISITOR_24H_WINDOW_SECONDS * 1000;

  return {
    liveVisitors: lastSeenAtMs.filter((timestamp) => timestamp >= liveCutoff).length,
    visitors24h: lastSeenAtMs.filter((timestamp) => timestamp >= dayCutoff).length,
  };
}
