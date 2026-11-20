import { useTranslation } from 'react-i18next';
import type { JSX } from 'react';

// Input for a secret the server never returns (Discord webhook URL, CallMeBot
// key). When the secret is already stored and the user has not started
// replacing it, shows "Configured" with Replace / Clear instead of a value.
// Otherwise renders the plain input. State lives in the parent so its Save
// button can decide whether to send the field at all.
export function WriteOnlySecretField({
  label,
  placeholder,
  type,
  isSet,
  replacing,
  value,
  onValueChange,
  onReplace,
  onClear,
  error,
}: {
  label: string;
  placeholder: string;
  type: 'url' | 'password';
  isSet: boolean;
  replacing: boolean;
  value: string;
  onValueChange: (v: string) => void;
  onReplace: () => void;
  onClear: () => void;
  error?: string | false;
}): JSX.Element {
  const { t } = useTranslation('settings');
  if (isSet && !replacing) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-ink-300">{label}</span>
        <div className="flex items-center gap-2">
          <span className="text-ink-200">{t('settings.notifications.secretConfigured')}</span>
          <button type="button" className="btn-secondary" onClick={onReplace}>
            {t('settings.notifications.secretReplace')}
          </button>
          <button type="button" className="btn-secondary" onClick={onClear}>
            {t('settings.notifications.secretClear')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <label className="flex flex-col gap-1">
      <span className="text-ink-300">{label}</span>
      <input
        type={type}
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        className="input"
      />
      {error && (
        <span role="alert" className="text-xs text-clay-300">
          {error}
        </span>
      )}
    </label>
  );
}
