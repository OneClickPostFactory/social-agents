import type { PlatformKey } from './types';

export interface PlatformEnableSettings {
  threads_enabled?: boolean | null;
  instagram_enabled?: boolean | null;
  linkedin_enabled?: boolean | null;
  x_enabled?: boolean | null;
  facebook_enabled?: boolean | null;
}

const PLATFORM_SETTINGS: ReadonlyArray<readonly [keyof PlatformEnableSettings, PlatformKey]> = [
  ['threads_enabled', 'threads'],
  ['instagram_enabled', 'instagram'],
  ['linkedin_enabled', 'linkedin'],
  ['x_enabled', 'x'],
  ['facebook_enabled', 'facebook'],
];

/**
 * SaaS platform activation is fail-closed. Missing, null, and false values are
 * disabled; only an explicit persisted boolean true opts a tenant in.
 */
export function activePlatformsFromSettings(settings: PlatformEnableSettings): PlatformKey[] {
  return PLATFORM_SETTINGS
    .filter(([setting]) => settings[setting] === true)
    .map(([, platform]) => platform);
}
