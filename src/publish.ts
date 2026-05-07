import * as facebook from './facebook';
import * as ai from './ai';
import * as cloudinary from './cloudinary';
import * as instagram from './instagram';
import * as linkedin from './linkedin';
import * as store from './store';
import * as threads from './threads';
import * as x from './x';
import config from '../config';

import type {
  Logger,
  PlatformKey,
  PublishErrors,
  PublishResult,
  QueueItem,
} from './types';

interface PlatformStep {
  key: PlatformKey;
  label: string;
  run: (item: QueueItem) => Promise<string>;
}

interface PlatformAvailability {
  enabled: boolean;
  reason?: string;
}

const PLATFORM_STEPS: PlatformStep[] = [
  { key: 'threads', label: 'Threads', run: item => threads.publish(item.threads) },
  { key: 'x', label: 'X', run: item => x.publish(item.x) },
  { key: 'instagram', label: 'Instagram', run: item => instagram.publish(item.instagram, item.imageUrl) },
  { key: 'linkedin', label: 'LinkedIn', run: item => linkedin.publish(item.linkedin) },
  { key: 'facebook', label: 'Facebook', run: item => facebook.publish(item.facebook) },
];

function getPlatformAvailability(step: PlatformStep, item: QueueItem): PlatformAvailability {
  const hasXOAuth1 = Boolean(
    config.X_API_KEY
    && config.X_API_SECRET
    && config.X_ACCESS_TOKEN
    && config.X_ACCESS_TOKEN_SECRET
  );
  const hasXOAuth2 = Boolean(config.X_OAUTH2_ACCESS_TOKEN);
  const xPublishState = step.key === 'x' ? store.getPlatformPublishState('x') : undefined;
  const xPublishBlocked = Boolean(
    xPublishState?.publishBlockedUntil
    && Date.parse(xPublishState.publishBlockedUntil) > Date.now()
  );

  switch (step.key) {
    case 'threads':
      if (!config.ENABLE_THREADS) return { enabled: false, reason: 'disabled via ENABLE_THREADS=false' };
      if (!config.THREADS_ACCESS_TOKEN) return { enabled: false, reason: 'THREADS_ACCESS_TOKEN not set' };
      if (!item.threads?.trim()) return { enabled: false, reason: 'Threads post text is empty' };
      return { enabled: true };

    case 'x':
      if (!config.ENABLE_X) return { enabled: false, reason: 'disabled via ENABLE_X=false' };
      if (!hasXOAuth1 && !hasXOAuth2) {
        return { enabled: false, reason: 'X auth not set (need OAuth 2.0 token or OAuth 1.0a key/token set)' };
      }
      if (xPublishBlocked) {
        return {
          enabled: false,
          reason: `draft-only mode until ${xPublishState?.publishBlockedUntil} (${xPublishState?.publishBlockedReason || 'X publish currently blocked'})`,
        };
      }
      if (!item.x?.trim()) return { enabled: false, reason: 'X post text is empty' };
      return { enabled: true };

    case 'instagram':
      if (!config.ENABLE_INSTAGRAM) return { enabled: false, reason: 'disabled via ENABLE_INSTAGRAM=false' };
      if (!config.FACEBOOK_PAGE_ACCESS_TOKEN && !config.META_ACCESS_TOKEN) {
        return { enabled: false, reason: 'FACEBOOK_PAGE_ACCESS_TOKEN or META_ACCESS_TOKEN not set' };
      }
      if (!config.INSTAGRAM_ACCOUNT_ID && !config.FACEBOOK_PAGE_ID) {
        return { enabled: false, reason: 'INSTAGRAM_ACCOUNT_ID or FACEBOOK_PAGE_ID not set' };
      }
      if (!item.instagram?.trim()) return { enabled: false, reason: 'Instagram caption is empty' };
      if (!item.imageUrl?.trim()) return { enabled: false, reason: 'imageUrl is empty' };
      return { enabled: true };

    case 'linkedin':
      if (!config.ENABLE_LINKEDIN) return { enabled: false, reason: 'disabled via ENABLE_LINKEDIN=false' };
      if (!config.LINKEDIN_TOKEN) return { enabled: false, reason: 'LINKEDIN_TOKEN not set' };
      if (!config.LINKEDIN_PERSON_URN) return { enabled: false, reason: 'LINKEDIN_PERSON_URN not set' };
      if (!item.linkedin?.trim()) return { enabled: false, reason: 'LinkedIn post text is empty' };
      return { enabled: true };

    case 'facebook':
      if (!config.ENABLE_FACEBOOK) return { enabled: false, reason: 'disabled via ENABLE_FACEBOOK=false' };
      if (!config.META_ACCESS_TOKEN) return { enabled: false, reason: 'META_ACCESS_TOKEN not set' };
      if (!config.FACEBOOK_GROUP_ID) return { enabled: false, reason: 'FACEBOOK_GROUP_ID not set' };
      if (!item.facebook?.trim()) return { enabled: false, reason: 'Facebook post text is empty' };
      return { enabled: true };
  }
}

export async function publishQueuedItem(item: QueueItem, logger?: Logger): Promise<PublishResult> {
  const nextItem: QueueItem = {
    ...item,
    ids: { ...(item.ids || {}) },
  };

  const errors: string[] = [];
  const publishErrors: PublishErrors = {};
  const activePlatforms: PlatformKey[] = [];
  const skippedPlatforms: PlatformKey[] = [];

  for (const step of PLATFORM_STEPS) {
    const availability = getPlatformAvailability(step, nextItem);
    if (!availability.enabled) {
      skippedPlatforms.push(step.key);
      logger?.warn(`[${step.label}] Skipped — ${availability.reason}`);
      continue;
    }

    activePlatforms.push(step.key);

    if (nextItem.ids?.[step.key]) {
      logger?.info(`[${step.label}] Skipped — already posted (${nextItem.ids[step.key]})`);
      continue;
    }

    try {
      if (step.key === 'instagram' && cloudinary.isConfigured() && !cloudinary.isCloudinaryUrl(nextItem.imageUrl)) {
        logger?.info('[Instagram] Refreshing image through Cloudinary before publish');
        Object.assign(nextItem, await ai.refreshInstagramImage(nextItem));
      }

      const postId = await step.run(nextItem);
      if (step.key === 'x') {
        store.clearPlatformPublishBlocked('x');
      }
      nextItem.ids = { ...(nextItem.ids || {}), [step.key]: postId };
      logger?.info(`[${step.label}] Posted — ID: ${postId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (step.key === 'x' && x.isPublishCapabilityBlockedError(message)) {
        const blockedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        store.setPlatformPublishBlocked('x', message, blockedUntil);
        const activeIndex = activePlatforms.indexOf(step.key);
        if (activeIndex >= 0) {
          activePlatforms.splice(activeIndex, 1);
        }
        skippedPlatforms.push(step.key);
        logger?.warn(`[${step.label}] Draft-only mode armed — ${message}`);
        continue;
      }
      publishErrors[step.key] = message;
      errors.push(`${step.label}: ${message}`);
      logger?.error(`[${step.label}] Failed: ${message}`);
    }
  }

  if (Object.keys(publishErrors).length) {
    nextItem.publishErrors = publishErrors;
  } else {
    delete nextItem.publishErrors;
  }

  nextItem.lastPublishAttemptAt = new Date().toISOString();

  const pendingPlatforms = PLATFORM_STEPS
    .filter(step => activePlatforms.includes(step.key))
    .filter(step => !nextItem.ids?.[step.key])
    .map(step => step.key);

  if (!activePlatforms.length) {
    const message = 'No enabled platforms are configured for this publish run';
    errors.push(message);
    logger?.error(message);
  }

  return {
    nextItem,
    ids: nextItem.ids || {},
    errors,
    pendingPlatforms,
    activePlatforms,
    skippedPlatforms,
    completed: activePlatforms.length > 0 && pendingPlatforms.length === 0,
  };
}

export { PLATFORM_STEPS };
