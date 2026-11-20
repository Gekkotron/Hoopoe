import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationsChannelsCard } from '../NotificationsChannelsCard';
import { DEFAULTS, type NotificationPrefs } from '../../../lib/settings';
import { pinLocale } from '../../../test/i18n';

pinLocale('settings');

function prefs(hasApiKey: boolean): NotificationPrefs {
  const n = DEFAULTS.notifications;
  return {
    ...n,
    channels: {
      ...n.channels,
      callmebot: { enabled: true, phone: '+33612345678', hasApiKey, maxPerMinute: 0 },
    },
  };
}

describe('NotificationsChannelsCard CallMeBot key', () => {
  it('shows Configured instead of the key and omits it on save', async () => {
    const onPatch = vi.fn();
    render(<NotificationsChannelsCard prefs={prefs(true)} onPatch={onPatch} />);
    expect(screen.getByText('Configuré')).toBeInTheDocument();
    await userEvent.clear(screen.getByPlaceholderText('0'));
    await userEvent.type(screen.getByPlaceholderText('0'), '2');
    await userEvent.click(screen.getByRole('button', { name: /enregistrer les paramètres callmebot/i }));
    expect(onPatch).toHaveBeenCalledWith({
      channels: { callmebot: { phone: '+33612345678', maxPerMinute: 2 } },
    });
    expect(JSON.stringify(onPatch.mock.calls)).not.toContain('apiKey');
  });

  it('Replace then save sends the new key; Clear sends an empty key', async () => {
    const onPatch = vi.fn();
    render(<NotificationsChannelsCard prefs={prefs(true)} onPatch={onPatch} />);
    await userEvent.click(screen.getByRole('button', { name: 'Effacer' }));
    expect(onPatch).toHaveBeenCalledWith({ channels: { callmebot: { apiKey: '' } } });
    await userEvent.click(screen.getByRole('button', { name: 'Remplacer' }));
    await userEvent.type(screen.getByPlaceholderText(/7 chiffres/), '1234567');
    await userEvent.click(screen.getByRole('button', { name: /enregistrer les paramètres callmebot/i }));
    expect(onPatch).toHaveBeenLastCalledWith({
      channels: { callmebot: { phone: '+33612345678', apiKey: '1234567', maxPerMinute: 0 } },
    });
  });

  it('shows the plain input when no key is stored', () => {
    render(<NotificationsChannelsCard prefs={prefs(false)} onPatch={vi.fn()} />);
    expect(screen.getByPlaceholderText(/7 chiffres/)).toBeInTheDocument();
  });
});
