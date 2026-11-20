import { useEffect, useState, type JSX } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { WriteOnlySecretField } from './WriteOnlySecretField';
import type { NotificationPrefs, NotificationPrefsPatch } from '../../lib/settings';

// Mirrors the backend's accepted webhook shape; a bad URL makes the PATCH 400.
export const DISCORD_WEBHOOK_RE =
  /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+\/?$/;

export function DiscordChannelFields({
  prefs,
  onPatch,
}: {
  prefs: NotificationPrefs;
  onPatch: (p: NotificationPrefsPatch) => void;
}): JSX.Element {
  const { t } = useTranslation('settings');
  const discord = prefs.channels.discord;
  const [url, setUrl] = useState('');
  const [replacing, setReplacing] = useState(false);
  const isSet = discord.hasWebhookUrl;
  // Back to the "Configured" view whenever the stored state changes (saved or cleared).
  useEffect(() => {
    setReplacing(false);
    setUrl('');
  }, [isSet]);
  const [maxPerMinute, setMaxPerMinute] = useState(String(discord.maxPerMinute));
  const maxParsed = Number.parseInt(maxPerMinute, 10);
  const maxValue = Number.isFinite(maxParsed) && maxParsed >= 0 ? maxParsed : 0;
  const trimmedUrl = url.trim();
  const urlInvalid = trimmedUrl !== '' && !DISCORD_WEBHOOK_RE.test(trimmedUrl);
  // The URL is only sent when the user typed a new one; otherwise it is
  // omitted so the stored secret is kept.
  const sendUrl = trimmedUrl !== '';
  const dirty = sendUrl || maxValue !== discord.maxPerMinute;
  const save = () => {
    onPatch({
      channels: { discord: sendUrl ? { webhookUrl: trimmedUrl, maxPerMinute: maxValue } : { maxPerMinute: maxValue } },
    });
  };

  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-ink-800/60 pt-3">
      <label className="flex items-center gap-2 text-sm text-ink-200">
        <input
          type="checkbox"
          checked={discord.enabled}
          onChange={(e) => onPatch({ channels: { discord: { enabled: e.target.checked } } })}
        />
        {t('settings.notifications.channels.discord.label')}
      </label>

      {discord.enabled && (
        <div className="flex flex-col gap-2 pl-6 text-sm">
          <WriteOnlySecretField
            label={t('settings.notifications.channels.discord.webhookUrlLabel')}
            placeholder={t('settings.notifications.channels.discord.webhookUrlPlaceholder')}
            type="url"
            isSet={isSet}
            replacing={replacing}
            value={url}
            onValueChange={setUrl}
            onReplace={() => setReplacing(true)}
            onClear={() => onPatch({ channels: { discord: { webhookUrl: '' } } })}
            error={urlInvalid && t('settings.notifications.channels.discord.webhookUrlInvalid')}
          />
          <label className="flex flex-col gap-1">
            <span className="text-ink-300">
              {t('settings.notifications.channels.discord.maxPerMinuteLabel')}
            </span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={maxPerMinute}
              onChange={(e) => setMaxPerMinute(e.target.value.replace(/[^0-9]/g, ''))}
              className="input"
              placeholder="0"
            />
            <span className="text-xs text-ink-400">
              {t('settings.notifications.channels.discord.maxPerMinuteHelp')}
            </span>
          </label>
          <button
            type="button"
            className="btn-secondary w-fit"
            onClick={save}
            disabled={!dirty || urlInvalid}
          >
            {t('settings.notifications.channels.discord.save')}
          </button>
          <p className="text-xs text-ink-400">
            <Trans i18nKey="settings.notifications.channels.discord.help" t={t}>
              Create a webhook in your Discord server — see
              <a
                className="underline hover:text-ink-100"
                href="https://support.discord.com/hc/en-us/articles/228383668"
                target="_blank"
                rel="noopener noreferrer"
              >
                Intro to Webhooks
              </a>
              .
            </Trans>
          </p>
        </div>
      )}
    </div>
  );
}
