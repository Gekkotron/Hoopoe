import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiscordChannelFields } from '../DiscordChannelFields';
import { DEFAULTS, type NotificationPrefs } from '../../../lib/settings';
import { pinLocale } from '../../../test/i18n';

pinLocale('settings');

const VALID = 'https://discord.com/api/webhooks/123456/abc-DEF_9';

function prefs(enabled: boolean, hasWebhookUrl = false): NotificationPrefs {
  const n = DEFAULTS.notifications;
  return {
    ...n,
    channels: { ...n.channels, discord: { enabled, hasWebhookUrl, maxPerMinute: 0 } },
  };
}

describe('DiscordChannelFields', () => {
  it('toggling the checkbox patches enabled', async () => {
    const onPatch = vi.fn();
    render(<DiscordChannelFields prefs={prefs(false)} onPatch={onPatch} />);
    await userEvent.click(screen.getByRole('checkbox'));
    expect(onPatch).toHaveBeenCalledWith({ channels: { discord: { enabled: true } } });
  });

  it('saves a valid URL with maxPerMinute', async () => {
    const onPatch = vi.fn();
    render(<DiscordChannelFields prefs={prefs(true)} onPatch={onPatch} />);
    const save = screen.getByRole('button', { name: /enregistrer/i });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText(/discord\.com\/api\/webhooks/), VALID);
    await userEvent.clear(screen.getByPlaceholderText('0'));
    await userEvent.type(screen.getByPlaceholderText('0'), '4');
    expect(save).toBeEnabled();
    await userEvent.click(save);
    expect(onPatch).toHaveBeenCalledWith({
      channels: { discord: { webhookUrl: VALID, maxPerMinute: 4 } },
    });
  });

  it('shows an error and disables Save for an invalid URL', async () => {
    const onPatch = vi.fn();
    render(<DiscordChannelFields prefs={prefs(true)} onPatch={onPatch} />);
    await userEvent.type(screen.getByPlaceholderText(/discord\.com\/api\/webhooks/), 'https://example.com/hook');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /enregistrer/i })).toBeDisabled();
  });

  describe('when a webhook is already configured', () => {
    it('shows Configured with Replace and Clear, and no URL input', () => {
      render(<DiscordChannelFields prefs={prefs(true, true)} onPatch={vi.fn()} />);
      expect(screen.getByText('Configuré')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Remplacer' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Effacer' })).toBeInTheDocument();
      expect(screen.queryByPlaceholderText(/discord\.com\/api\/webhooks/)).not.toBeInTheDocument();
    });

    it('saving without editing omits the secret', async () => {
      const onPatch = vi.fn();
      render(<DiscordChannelFields prefs={prefs(true, true)} onPatch={onPatch} />);
      await userEvent.clear(screen.getByPlaceholderText('0'));
      await userEvent.type(screen.getByPlaceholderText('0'), '7');
      await userEvent.click(screen.getByRole('button', { name: /enregistrer/i }));
      expect(onPatch).toHaveBeenCalledWith({ channels: { discord: { maxPerMinute: 7 } } });
      expect(JSON.stringify(onPatch.mock.calls)).not.toContain('webhookUrl');
    });

    it('Replace reveals an empty input and sends the new URL', async () => {
      const onPatch = vi.fn();
      render(<DiscordChannelFields prefs={prefs(true, true)} onPatch={onPatch} />);
      await userEvent.click(screen.getByRole('button', { name: 'Remplacer' }));
      const input = screen.getByPlaceholderText(/discord\.com\/api\/webhooks/);
      expect(input).toHaveValue('');
      await userEvent.type(input, VALID);
      await userEvent.click(screen.getByRole('button', { name: /enregistrer/i }));
      expect(onPatch).toHaveBeenCalledWith({
        channels: { discord: { webhookUrl: VALID, maxPerMinute: 0 } },
      });
    });

    it('Clear sends an empty webhookUrl', async () => {
      const onPatch = vi.fn();
      render(<DiscordChannelFields prefs={prefs(true, true)} onPatch={onPatch} />);
      await userEvent.click(screen.getByRole('button', { name: 'Effacer' }));
      expect(onPatch).toHaveBeenCalledWith({ channels: { discord: { webhookUrl: '' } } });
    });
  });
});
