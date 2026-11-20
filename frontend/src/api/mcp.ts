import { api } from './client';

export type McpSettings = { enabled: boolean; hasToken: boolean; readOnly: boolean };

export function getMcpSettings() {
  return api<McpSettings>('/api/settings/mcp');
}
export function setMcpEnabled(enabled: boolean) {
  return api<McpSettings>('/api/settings/mcp', { method: 'PUT', json: { enabled } });
}
// readOnly=true blocks create/update/delete over MCP. Never touches the token.
export function setMcpReadOnly(readOnly: boolean) {
  return api<McpSettings>('/api/settings/mcp', { method: 'PUT', json: { readOnly } });
}
export function generateMcpToken() {
  return api<{ token: string }>('/api/settings/mcp/token', { method: 'POST' });
}
export function revokeMcpToken() {
  return api<{ ok: boolean }>('/api/settings/mcp/token', { method: 'DELETE' });
}
