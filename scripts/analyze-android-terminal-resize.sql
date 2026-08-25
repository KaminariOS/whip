WITH resize_events AS (
  SELECT
    ts,
    name,
    LAG(ts) OVER (ORDER BY ts) AS previous_ts
  FROM slice
  WHERE name GLOB 'Whip terminal resize event: *'
),
labeled_events AS (
  SELECT
    *,
    SUM(CASE WHEN previous_ts IS NULL OR ts - previous_ts > 750000000 THEN 1 ELSE 0 END)
      OVER (ORDER BY ts) AS batch
  FROM resize_events
),
batch_starts AS (
  SELECT batch, MIN(ts) AS start_ts
  FROM labeled_events
  GROUP BY batch
),
batch_bounds AS (
  SELECT
    batch,
    start_ts,
    COALESCE(LEAD(start_ts) OVER (ORDER BY batch), 9223372036854775807) AS end_ts
  FROM batch_starts
)
SELECT
  bounds.batch,
  CASE
    WHEN bounds.batch = 1 THEN 'first visit / cold resize burst'
    WHEN bounds.batch = 2 THEN 'return / warm resize burst'
    ELSE 'additional resize burst'
  END AS phase,
  (SELECT COUNT(*) FROM labeled_events event WHERE event.batch = bounds.batch) AS requests,
  (SELECT COUNT(*) FROM labeled_events event
    WHERE event.batch = bounds.batch AND event.name GLOB '* fit *') AS fit_requests,
  (SELECT COUNT(*) FROM labeled_events event
    WHERE event.batch = bounds.batch AND event.name GLOB '* xterm *') AS xterm_requests,
  (SELECT COUNT(*) FROM slice stage
    WHERE stage.name = 'Whip terminal resize superseded'
      AND stage.ts >= bounds.start_ts AND stage.ts < bounds.end_ts) AS superseded,
  (SELECT COUNT(*) FROM slice stage
    WHERE stage.name = 'Whip terminal resize deduplicated'
      AND stage.ts >= bounds.start_ts AND stage.ts < bounds.end_ts) AS deduplicated,
  (SELECT ROUND(AVG(stage.dur) / 1000000.0, 2) FROM slice stage
    WHERE stage.name = 'Whip terminal resize wait for writable'
      AND stage.dur >= 0 AND stage.dur < 9000000000
      AND stage.ts >= bounds.start_ts AND stage.ts < bounds.end_ts) AS wait_for_writable_ms,
  (SELECT ROUND(AVG(stage.dur) / 1000000.0, 2) FROM slice stage
    WHERE stage.name = 'Whip terminal resize native dispatch'
      AND stage.dur >= 0 AND stage.dur < 9000000000
      AND stage.ts >= bounds.start_ts AND stage.ts < bounds.end_ts) AS native_dispatch_ms,
  (SELECT ROUND(AVG(stage.dur) / 1000000.0, 2) FROM slice stage
    WHERE stage.name = 'Whip terminal resize to first frame'
      AND stage.dur >= 0 AND stage.dur < 9000000000
      AND stage.ts >= bounds.start_ts AND stage.ts < bounds.end_ts) AS to_first_frame_ms,
  (SELECT ROUND(AVG(stage.dur) / 1000000.0, 2) FROM slice stage
    WHERE stage.name = 'Whip terminal resize frame to visible'
      AND stage.dur >= 0 AND stage.dur < 9000000000
      AND stage.ts >= bounds.start_ts AND stage.ts < bounds.end_ts) AS frame_to_visible_ms,
  (SELECT ROUND(AVG(stage.dur) / 1000000.0, 2) FROM slice stage
    WHERE stage.name = 'Whip terminal resize to visible'
      AND stage.dur >= 0 AND stage.dur < 9000000000
      AND stage.ts >= bounds.start_ts AND stage.ts < bounds.end_ts) AS resize_to_visible_ms,
  (SELECT COUNT(*) FROM slice stage
    WHERE stage.name = 'Whip terminal resize to visible'
      AND stage.dur >= 9000000000
      AND stage.ts >= bounds.start_ts AND stage.ts < bounds.end_ts) AS timeouts
FROM batch_bounds bounds
ORDER BY bounds.batch;
