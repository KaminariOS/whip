SELECT
  ROUND((ts - MIN(ts) OVER ()) / 1000000.0, 2) AS offset_ms,
  SUBSTR(name, LENGTH('Whip terminal resize event: ') + 1) AS resize_event
FROM slice
WHERE name GLOB 'Whip terminal resize event: *'
ORDER BY ts;
