import assert from 'node:assert/strict';

import { activePlatformsFromSettings } from '../src/platform-settings';

assert.deepEqual(
  activePlatformsFromSettings({}),
  [],
  'missing platform settings must fail closed'
);

assert.deepEqual(
  activePlatformsFromSettings({
    threads_enabled: null,
    instagram_enabled: null,
    linkedin_enabled: null,
    x_enabled: null,
    facebook_enabled: null,
  }),
  [],
  'null platform settings must fail closed'
);

assert.deepEqual(
  activePlatformsFromSettings({
    threads_enabled: false,
    instagram_enabled: false,
    linkedin_enabled: false,
    x_enabled: false,
    facebook_enabled: false,
  }),
  [],
  'false platform settings must remain disabled'
);

assert.deepEqual(
  activePlatformsFromSettings({
    threads_enabled: true,
    instagram_enabled: false,
    linkedin_enabled: null,
    x_enabled: true,
  }),
  ['threads', 'x'],
  'only explicit true settings must become active'
);

assert.deepEqual(
  activePlatformsFromSettings({
    threads_enabled: true,
    instagram_enabled: true,
    linkedin_enabled: true,
    x_enabled: true,
    facebook_enabled: true,
  }),
  ['threads', 'instagram', 'linkedin', 'x', 'facebook'],
  'explicit opt-in must preserve canonical platform order'
);

console.log('tenant platform policy tests passed');
