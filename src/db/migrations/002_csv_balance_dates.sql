-- Older CSV imports used the import time for a balance taken from a dated row.
-- Keep the newest import of each account/day, then move it to that statement
-- day. The CSV raw balance carries {line,date}; OFX balances do not.
DELETE FROM account_balances
WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (
      PARTITION BY account_id, json_extract(raw_json, '$.date')
      ORDER BY as_of DESC, id DESC
    ) AS occurrence
    FROM account_balances
    WHERE json_type(raw_json, '$.line') = 'integer'
      AND json_type(raw_json, '$.date') = 'text'
      AND json_extract(raw_json, '$.date') GLOB
        '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND as_of <> json_extract(raw_json, '$.date') || 'T23:59:59.999Z'
  )
  WHERE occurrence > 1
);

-- A balance already at the corrected timestamp wins over an older copy.
DELETE FROM account_balances AS older
WHERE json_type(older.raw_json, '$.line') = 'integer'
  AND json_type(older.raw_json, '$.date') = 'text'
  AND json_extract(older.raw_json, '$.date') GLOB
    '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  AND older.as_of <> json_extract(older.raw_json, '$.date') || 'T23:59:59.999Z'
  AND EXISTS (
    SELECT 1 FROM account_balances AS dated
    WHERE dated.account_id = older.account_id
      AND dated.as_of = json_extract(older.raw_json, '$.date') || 'T23:59:59.999Z'
  );

UPDATE account_balances
SET as_of = json_extract(raw_json, '$.date') || 'T23:59:59.999Z'
WHERE json_type(raw_json, '$.line') = 'integer'
  AND json_type(raw_json, '$.date') = 'text'
  AND json_extract(raw_json, '$.date') GLOB
    '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]';
