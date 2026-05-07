import config from '../config';

import * as store from './store';
import * as x from './x';

async function main(): Promise<void> {
  const livePost = process.argv.includes('--live-post');
  const authMode = x.getConfiguredAuthMode();

  console.log('\n-- X Credential Test ------------------------');
  console.log(`ENABLE_X: ${config.ENABLE_X ? 'true' : 'false'}`);
  console.log(`Auth mode: ${authMode}`);
  console.log(`X_API_KEY configured: ${config.X_API_KEY ? 'yes' : 'no'}`);
  console.log(`X_ACCESS_TOKEN configured: ${config.X_ACCESS_TOKEN ? 'yes' : 'no'}`);
  console.log(`X_OAUTH2_ACCESS_TOKEN configured: ${config.X_OAUTH2_ACCESS_TOKEN ? 'yes' : 'no'}`);
  console.log(`X_OAUTH2_REFRESH_TOKEN configured: ${config.X_OAUTH2_REFRESH_TOKEN ? 'yes' : 'no'}`);
  console.log(`X_CLIENT_ID configured: ${config.X_CLIENT_ID ? 'yes' : 'no'}`);

  if (config.X_CLIENT_ID && config.X_CLIENT_SECRET && !config.X_OAUTH2_REFRESH_TOKEN) {
    console.log(`\nOAuth 2.0 user connect URL: ${new URL('/auth/x/start', config.X_REDIRECT_URI).toString()}`);
  }

  if (authMode === 'unconfigured') {
    console.log('\nNo supported X auth is configured. Add OAuth 1.0a user credentials or a real OAuth 2.0 user token before testing X.');
    return;
  }

  console.log('\nValidating authenticated X user...');
  const me = await x.getAuthenticatedUser();
  console.log(`OK authenticated as ${me.username ? '@' + me.username : me.name || me.id} (${me.id})`);

  if (!livePost) {
    console.log('\nDry run only. Pass --live-post to publish a test post.');
    return;
  }

  const testText = `Testing Social Agent X publishing flow at ${new Date().toISOString()}.`;
  console.log('\nPosting test update...');
  try {
    const id = await x.publish(testText);
    store.clearPlatformPublishBlocked('x');
    console.log(`OK posted https://x.com/i/web/status/${id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (x.isPublishCapabilityBlockedError(message)) {
      const blockedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      store.setPlatformPublishBlocked('x', message, blockedUntil);
      console.error('\nX publish probe result: AUTH OK / PUBLISH BLOCKED BY ACCESS LEVEL');
      console.error(`Blocked until: ${blockedUntil}`);
      console.error(`Provider response: ${message}`);
      process.exit(2);
    }
    throw error;
  }
}

void main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('X test failed:', message);
  process.exit(1);
});
