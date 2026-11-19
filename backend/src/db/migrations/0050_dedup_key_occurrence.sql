-- Dedup keys gain an occurrence number so two identical FITID-less rows
-- (same account, date, amount, label: two coffees on the same day) no
-- longer collapse into one on import.
--
-- New format: hash2:<sha256("<legacy sha1 hex>|#<n>")>. Every existing
-- `hash:<sha1 hex>` key becomes occurrence #1, derived from the stored
-- key alone, so rows edited since import keep their original identity and
-- re-imports still find them. Must stay in sync with
-- upgradeLegacyDedupKey() in src/domain/imports/dedup.ts.
--
-- The mapping is injective and no `hash2:` key exists before this
-- migration, so UNIQUE(account_id, dedup_key) cannot be violated.
-- `fitid:` keys and any other prefix are left untouched.

UPDATE transactions
   SET dedup_key = 'hash2:' || encode(sha256(convert_to(substr(dedup_key, 6) || '|#1', 'UTF8')), 'hex')
 WHERE dedup_key ~ '^hash:[0-9a-f]{40}$';
