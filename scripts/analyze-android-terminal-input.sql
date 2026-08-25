WITH input_roots AS (
  SELECT
    ts,
    dur,
    ROW_NUMBER() OVER (ORDER BY ts) AS sample,
    LAG(ts) OVER (ORDER BY ts) AS previous_ts
  FROM slice
  WHERE name = 'Whip terminal input to visible'
    AND dur >= 0
    AND dur < 9000000000
),
input_batches AS (
  SELECT
    *,
    SUM(CASE WHEN previous_ts IS NULL OR ts - previous_ts > 750000000 THEN 1 ELSE 0 END)
      OVER (ORDER BY ts) AS batch
  FROM input_roots
),
ranked_stages AS (
  SELECT
    name,
    dur,
    ROW_NUMBER() OVER (PARTITION BY name ORDER BY ts) AS sample
  FROM slice
  WHERE name IN (
    'Whip terminal input to native dispatch',
    'Whip terminal native queue to response',
    'Whip terminal frame to visible'
  )
    AND dur >= 0
    AND dur < 9000000000
),
samples AS (
  SELECT
    root.batch,
    root.sample,
    root.dur AS total_dur,
    local.dur AS local_dur,
    remote.dur AS remote_dur,
    visible.dur AS visible_dur
  FROM input_batches root
  LEFT JOIN ranked_stages local
    ON local.sample = root.sample
   AND local.name = 'Whip terminal input to native dispatch'
  LEFT JOIN ranked_stages remote
    ON remote.sample = root.sample
   AND remote.name = 'Whip terminal native queue to response'
  LEFT JOIN ranked_stages visible
    ON visible.sample = root.sample
   AND visible.name = 'Whip terminal frame to visible'
)
SELECT
  batch,
  CASE WHEN batch = 1 THEN 'first visit / cold' ELSE 'return / warm' END AS phase,
  COUNT(*) AS samples,
  ROUND(AVG(local_dur) / 1000000.0, 2) AS local_dispatch_ms,
  ROUND(AVG(remote_dur) / 1000000.0, 2) AS queue_to_response_ms,
  ROUND(AVG(visible_dur) / 1000000.0, 2) AS frame_to_visible_ms,
  ROUND(AVG(total_dur) / 1000000.0, 2) AS input_to_visible_ms,
  ROUND(MIN(total_dur) / 1000000.0, 2) AS min_ms,
  ROUND(MAX(total_dur) / 1000000.0, 2) AS max_ms,
  CASE WHEN batch = 1 THEN (
    SELECT COUNT(*) FROM slice WHERE name = 'Whip terminal cold input to writable' AND dur >= 0
  ) ELSE 0 END AS cold_wait_samples,
  CASE WHEN batch = 1 THEN (
    SELECT ROUND(AVG(dur) / 1000000.0, 2)
    FROM slice
    WHERE name = 'Whip terminal cold input to writable' AND dur >= 0
  ) END AS cold_wait_ms,
  CASE WHEN batch = 1 THEN (
    SELECT ROUND(dur / 1000000.0, 2)
    FROM slice
    WHERE name = 'Whip terminal renderer readiness' AND dur >= 0
    ORDER BY ts
    LIMIT 1
  ) END AS renderer_readiness_ms,
  CASE WHEN batch = 1 THEN (
    SELECT ROUND(dur / 1000000.0, 2)
    FROM slice
    WHERE name = 'Whip terminal bridge attach' AND dur >= 0
    ORDER BY ts
    LIMIT 1
  ) END AS bridge_attach_ms
FROM samples
GROUP BY batch
ORDER BY batch;
