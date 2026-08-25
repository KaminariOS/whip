SELECT
  name,
  SUM(CASE WHEN dur >= 0 AND dur < 9000000000 THEN 1 ELSE 0 END) AS samples,
  SUM(CASE WHEN dur >= 9000000000 THEN 1 ELSE 0 END) AS timeouts,
  SUM(CASE WHEN dur = -1 THEN 1 ELSE 0 END) AS incomplete,
  ROUND(AVG(CASE WHEN dur >= 0 AND dur < 9000000000 THEN dur END) / 1000000.0, 2) AS avg_ms,
  ROUND(PERCENTILE(CASE WHEN dur >= 0 AND dur < 9000000000 THEN dur END, 50) / 1000000.0, 2) AS p50_ms,
  ROUND(PERCENTILE(CASE WHEN dur >= 0 AND dur < 9000000000 THEN dur END, 95) / 1000000.0, 2) AS p95_ms,
  ROUND(MIN(CASE WHEN dur >= 0 AND dur < 9000000000 THEN dur END) / 1000000.0, 2) AS min_ms,
  ROUND(MAX(CASE WHEN dur >= 0 AND dur < 9000000000 THEN dur END) / 1000000.0, 2) AS max_ms
FROM slice
WHERE (
    name GLOB 'Whip terminal *'
    OR name GLOB 'Whip Herdr *'
    OR name GLOB 'Whip exec inbound *'
  )
  AND name NOT GLOB 'Whip terminal resize event: *'
  AND dur != 0
GROUP BY name
ORDER BY avg_ms DESC;

SELECT
  name,
  SUM(CASE WHEN dur >= 0 AND dur < 9000000000 THEN 1 ELSE 0 END) AS samples,
  SUM(CASE WHEN dur >= 9000000000 THEN 1 ELSE 0 END) AS timeouts,
  SUM(CASE WHEN dur = -1 THEN 1 ELSE 0 END) AS incomplete,
  ROUND(AVG(CASE WHEN dur >= 0 AND dur < 9000000000 THEN dur END) / 1000000.0, 2) AS avg_ms,
  ROUND(PERCENTILE(CASE WHEN dur >= 0 AND dur < 9000000000 THEN dur END, 50) / 1000000.0, 2) AS p50_ms,
  ROUND(PERCENTILE(CASE WHEN dur >= 0 AND dur < 9000000000 THEN dur END, 95) / 1000000.0, 2) AS p95_ms,
  ROUND(MIN(CASE WHEN dur >= 0 AND dur < 9000000000 THEN dur END) / 1000000.0, 2) AS min_ms,
  ROUND(MAX(CASE WHEN dur >= 0 AND dur < 9000000000 THEN dur END) / 1000000.0, 2) AS max_ms
FROM slice
WHERE (
    name GLOB 'Whip terminal resize: *'
    OR name IN (
      'Whip terminal resize request',
      'Whip terminal resize wait for writable',
      'Whip terminal resize native dispatch',
      'Whip terminal resize to first frame',
      'Whip terminal resize frame to visible',
      'Whip terminal resize to visible',
      'Whip terminal resize superseded',
      'Whip terminal resize deduplicated',
      'Whip Herdr terminal initial resize'
    )
  )
  AND name NOT GLOB 'Whip terminal resize event: *'
  AND dur >= -1
GROUP BY name
ORDER BY name;

-- Chronological resize ledger. The event names carry a capture-local sequence,
-- source, dimensions, cell size, WebView queue delay, and fit duration so a
-- cold fit/xterm/fit burst can be compared with actual native-dispatch counts.
SELECT
  ROUND(ts / 1000000.0, 2) AS trace_ts_ms,
  name
FROM slice
WHERE name GLOB 'Whip terminal resize event: *'
ORDER BY ts;

SELECT
  name,
  COUNT(*) AS samples,
  ROUND(AVG(dur) / 1000000.0, 2) AS avg_ms,
  ROUND(MIN(dur) / 1000000.0, 2) AS min_ms,
  ROUND(MAX(dur) / 1000000.0, 2) AS max_ms
FROM slice
WHERE (
    name GLOB 'Whip startup *'
    OR name GLOB 'Whip first tab mount: *'
    OR name = 'Whip host snapshot refresh'
    OR name = 'Whip host latency state apply'
    OR name GLOB 'Whip terminal offline cache *'
    OR name = 'Whip transcript initial parse'
  )
  AND dur > 0
GROUP BY name
ORDER BY avg_ms DESC;
