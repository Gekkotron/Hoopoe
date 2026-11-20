import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SettingsSecurityPage } from '../Settings/SettingsSecurityPage';
import { pinLocale } from '../../test/i18n';
import { getMcpSettings, setMcpReadOnly } from '../../api/mcp';

// Preload 'settings'/'common' for both locales and pin French so
// `useTranslation` never suspends mid-render and existing assertions keep
// matching real rendered text.
pinLocale('settings');

vi.mock('../../api/mcp', () => ({
  getMcpSettings: vi.fn().mockResolvedValue({ enabled: false, hasToken: false, readOnly: true }),
  setMcpEnabled: vi.fn().mockResolvedValue({ enabled: true, hasToken: false, readOnly: true }),
  setMcpReadOnly: vi.fn().mockResolvedValue({ enabled: false, hasToken: false, readOnly: false }),
  generateMcpToken: vi.fn().mockResolvedValue({ token: 'EXAMPLE_TOKEN_123456789' }),
  revokeMcpToken: vi.fn().mockResolvedValue({ ok: true }),
}));

// SettingsSecurityPage also mounts SettingsSecurity + SettingsLock, which
// hit /api/security and /api/auth/lock-status. Both components early-return
// null when their status query has no data, so returning empty objects
// keeps the DOM focused on the MCP section this suite exercises.
vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client');
  return { ...actual, api: vi.fn().mockResolvedValue({}) };
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><SettingsSecurityPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SettingsSecurityPage — Accès MCP', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the MCP section', async () => {
    renderPage();
    expect(await screen.findByTestId('mcp-section')).toBeInTheDocument();
  });

  it('reveals a token once after generate', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('mcp-generate'));
    await waitFor(() => expect(screen.getByTestId('mcp-token')).toHaveTextContent('EXAMPLE_TOKEN_123456789'));
  });

  it('shows "Allow changes" off by default (read-only) and sends readOnly:false when ticked', async () => {
    renderPage();
    const box = (await screen.findByTestId('mcp-allow-changes')) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(false));
    fireEvent.click(box);
    await waitFor(() => expect(setMcpReadOnly).toHaveBeenCalledWith(false));
  });

  it('reflects write access and sends readOnly:true when unticked', async () => {
    vi.mocked(getMcpSettings).mockResolvedValue({ enabled: true, hasToken: true, readOnly: false });
    renderPage();
    const box = (await screen.findByTestId('mcp-allow-changes')) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(true));
    fireEvent.click(box);
    await waitFor(() => expect(setMcpReadOnly).toHaveBeenCalledWith(true));
  });
});
