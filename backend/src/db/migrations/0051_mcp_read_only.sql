-- MCP read-only scope, per user. New users default to read-only (true); anyone
-- who already uses MCP (enabled, or holding a token) keeps write access so the
-- upgrade does not break their existing setup.
ALTER TABLE user_settings
  ADD COLUMN mcp_read_only boolean NOT NULL DEFAULT true;

UPDATE user_settings
  SET mcp_read_only = false
  WHERE mcp_enabled OR mcp_key_wrapped IS NOT NULL;
