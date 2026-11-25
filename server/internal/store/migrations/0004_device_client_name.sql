-- 0004: devices.client_name
-- The admin may pre-bind a device name via the pair code; the client also
-- self-reports one. Keep BOTH: name (authoritative, the bound one) and
-- client_name (what the client called itself) for display context.
ALTER TABLE devices ADD COLUMN client_name TEXT NOT NULL DEFAULT '';
