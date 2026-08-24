SELECT
  name,
  SUM(CASE WHEN dur < 9000000000 THEN 1 ELSE 0 END) AS samples,
  SUM(CASE WHEN dur >= 9000000000 THEN 1 ELSE 0 END) AS timeouts,
  ROUND(AVG(CASE WHEN dur < 9000000000 THEN dur END) / 1000000.0, 2) AS avg_ms,
  ROUND(MIN(CASE WHEN dur < 9000000000 THEN dur END) / 1000000.0, 2) AS min_ms,
  ROUND(MAX(CASE WHEN dur < 9000000000 THEN dur END) / 1000000.0, 2) AS max_ms
FROM slice
WHERE name GLOB 'Whip terminal *'
  AND dur > 0
GROUP BY name
ORDER BY avg_ms DESC;

SELECT
  name,
  COUNT(*) AS samples,
  ROUND(AVG(dur) / 1000000.0, 2) AS avg_ms,
  ROUND(MIN(dur) / 1000000.0, 2) AS min_ms,
  ROUND(MAX(dur) / 1000000.0, 2) AS max_ms
FROM slice
WHERE name GLOB 'Whip terminal resize: *'
  AND dur >= 0
GROUP BY name
ORDER BY name;

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
    OR name = 'Whip transcript initial parse'
  )
  AND dur > 0
GROUP BY name
ORDER BY avg_ms DESC;
