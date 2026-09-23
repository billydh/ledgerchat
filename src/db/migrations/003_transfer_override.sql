-- Earlier releases treated equal and opposite amounts as proof of a transfer
-- and could hide unrelated payments from spending reports. Clear those guesses;
-- the migration runner rechecks pairs using both descriptions' transfer hints.
ALTER TABLE transactions ADD COLUMN transfer_override INTEGER
  CHECK (transfer_override IN (0, 1));

UPDATE transactions
SET is_internal_transfer = 0, transfer_source = NULL, transfer_pair_id = NULL
WHERE transfer_source IS NOT NULL;
