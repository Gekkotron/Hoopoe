// Pure helpers that turn the stored user_settings JSON into its portable
// backup form and back.
//
// Two things make the raw blob unfit to copy as-is:
//  1. It holds the notification-channel secrets (Discord webhook URL,
//     CallMeBot API key), encrypted under a SESSION_SECRET-derived key (or
//     still plaintext on a legacy row). They never leave the instance: they
//     are stripped from the dump, and on restore the target's own secrets are
//     kept (the ciphertext would not decrypt under another SESSION_SECRET
//     anyway).
//  2. A few keys are keyed by account database id, which a restore
//     regenerates. They are moved out of the blob into `accountRefs`, keyed
//     by account name, and re-keyed to the new ids on restore.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

// Per channel, every key that carries a secret (plaintext legacy or encrypted).
const SECRET_KEYS: Record<'discord' | 'callmebot', readonly string[]> = {
  discord: ['webhookUrl', 'webhookUrlEnc'],
  callmebot: ['apiKey', 'apiKeyEnc'],
};

export type SettingsAccountRefs = {
  transactionsDefaultAccount?: string | null;
  dashboardChartScope?: string | null;
  bigTransactionThresholds?: Record<string, number>;
  accountLowFloors?: Record<string, number>;
};

export type DumpedSettings = { settings: Obj; accountRefs?: SettingsAccountRefs };

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function channelOf(settings: Obj, channel: 'discord' | 'callmebot'): Obj | null {
  const n = settings.notifications;
  if (!isObj(n) || !isObj(n.channels)) return null;
  const c = n.channels[channel];
  return isObj(c) ? c : null;
}

// Mutates `settings` (a private clone): deletes every secret key.
function stripSecrets(settings: Obj): void {
  for (const channel of ['discord', 'callmebot'] as const) {
    const c = channelOf(settings, channel);
    if (!c) continue;
    for (const k of SECRET_KEYS[channel]) delete c[k];
  }
}

function triggerOf(settings: Obj, trigger: 'bigTransaction' | 'accountLow'): Obj | null {
  const n = settings.notifications;
  if (!isObj(n) || !isObj(n.triggers)) return null;
  const t = n.triggers[trigger];
  return isObj(t) ? t : null;
}

function renameKeys(
  map: unknown,
  nameById: Map<number, string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(map)) return out;
  for (const [id, v] of Object.entries(map)) {
    const name = nameById.get(Number(id));
    if (name !== undefined && typeof v === 'number') out[name] = v;
  }
  return out;
}

export function toDumpedSettings(raw: unknown, accountNameById: Map<number, string>): DumpedSettings {
  const settings = isObj(raw) ? clone(raw) : {};
  stripSecrets(settings);

  const refs: SettingsAccountRefs = {};
  for (const key of ['transactionsDefaultAccount', 'dashboardChartScope'] as const) {
    const v = settings[key];
    if (typeof v === 'number') {
      refs[key] = accountNameById.get(v) ?? null;
      delete settings[key];
    }
  }
  const big = triggerOf(settings, 'bigTransaction');
  if (big && 'thresholds' in big) {
    refs.bigTransactionThresholds = renameKeys(big.thresholds, accountNameById);
    delete big.thresholds;
  }
  const low = triggerOf(settings, 'accountLow');
  if (low && 'floors' in low) {
    refs.accountLowFloors = renameKeys(low.floors, accountNameById);
    delete low.floors;
  }
  return Object.keys(refs).length > 0 ? { settings, accountRefs: refs } : { settings };
}

function renameBack(
  map: Record<string, number> | undefined,
  idByName: Map<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, v] of Object.entries(map ?? {})) {
    const id = idByName.get(name);
    if (id !== undefined) out[String(id)] = v;
  }
  return out;
}

// Builds the settings JSON to store: the dumped blob, account refs re-keyed to
// the restored account ids (unresolved names dropped), and the target's
// current secrets (`existingRaw`) carried over. Any secret a hand-edited dump
// smuggled in is stripped first, so plaintext can never reach the table.
export function fromDumpedSettings(
  dumped: DumpedSettings,
  existingRaw: unknown,
  accountIdByName: Map<string, number>,
): Obj {
  const settings = clone(dumped.settings);
  stripSecrets(settings);

  const refs = dumped.accountRefs ?? {};
  for (const key of ['transactionsDefaultAccount', 'dashboardChartScope'] as const) {
    const name = refs[key];
    const id = typeof name === 'string' ? accountIdByName.get(name) : undefined;
    if (id !== undefined) settings[key] = id;
  }
  if (refs.bigTransactionThresholds !== undefined) {
    ensureTrigger(settings, 'bigTransaction').thresholds = renameBack(refs.bigTransactionThresholds, accountIdByName);
  }
  if (refs.accountLowFloors !== undefined) {
    ensureTrigger(settings, 'accountLow').floors = renameBack(refs.accountLowFloors, accountIdByName);
  }

  if (isObj(existingRaw)) {
    for (const channel of ['discord', 'callmebot'] as const) {
      const current = channelOf(existingRaw, channel);
      if (!current) continue;
      const kept: Obj = {};
      for (const k of SECRET_KEYS[channel]) if (k in current) kept[k] = current[k];
      if (Object.keys(kept).length === 0) continue;
      Object.assign(ensureChannel(settings, channel), kept);
    }
  }
  return settings;
}

function ensureObj(parent: Obj, key: string): Obj {
  const v = parent[key];
  if (isObj(v)) return v;
  const created: Obj = {};
  parent[key] = created;
  return created;
}

function ensureChannel(settings: Obj, channel: 'discord' | 'callmebot'): Obj {
  return ensureObj(ensureObj(ensureObj(settings, 'notifications'), 'channels'), channel);
}

function ensureTrigger(settings: Obj, trigger: 'bigTransaction' | 'accountLow'): Obj {
  return ensureObj(ensureObj(ensureObj(settings, 'notifications'), 'triggers'), trigger);
}
