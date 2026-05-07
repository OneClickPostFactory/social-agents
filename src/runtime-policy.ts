import config from '../config';

import {
  canAccessAutomation,
  getBillingState,
  getBillingStateSnapshot,
  hasUsers,
  isLocalDevBillingBypassActive,
} from './control-plane';

export interface RuntimeReadiness {
  ready: boolean;
  missing: string[];
  enabledPlatforms: string[];
}

export interface AutomationGate {
  allowed: boolean;
  reasons: string[];
  readiness: RuntimeReadiness;
  billing: ReturnType<typeof getBillingState>;
  billingAccessActive: boolean;
  localBillingBypassActive: boolean;
  hasOwner: boolean;
}

export function getEnabledPlatformLabels(): string[] {
  const labels: string[] = [];
  if (config.ENABLE_THREADS) labels.push('Threads');
  if (config.ENABLE_X) labels.push('X');
  if (config.ENABLE_INSTAGRAM) labels.push('Instagram');
  if (config.ENABLE_LINKEDIN) labels.push('LinkedIn');
  if (config.ENABLE_FACEBOOK) labels.push('Facebook');
  return labels;
}

export function getRuntimeReadiness(): RuntimeReadiness {
  const missing: string[] = [];
  const enabledPlatforms = getEnabledPlatformLabels();
  const hasXOAuth1 = Boolean(
    config.X_API_KEY
    && config.X_API_SECRET
    && config.X_ACCESS_TOKEN
    && config.X_ACCESS_TOKEN_SECRET
  );
  const hasXOAuth2 = Boolean(config.X_OAUTH2_ACCESS_TOKEN);
  const canStartXOAuth2 = Boolean(config.X_CLIENT_ID && config.X_CLIENT_SECRET);
  const hasCloudinaryAuth = Boolean(
    config.CLOUDINARY_UPLOAD_PRESET
    || (config.CLOUDINARY_API_KEY && config.CLOUDINARY_API_SECRET)
  );

  if (!config.OPENAI_API_KEY) {
    missing.push('OPENAI_API_KEY');
  }

  if (!config.REDDIT_USER) {
    missing.push('REDDIT_USER');
  }

  if (!config.REDDIT_ALLOWED_SUBS.size) {
    missing.push('REDDIT_ALLOWED_SUBS');
  }

  if (!enabledPlatforms.length) {
    missing.push('At least one enabled platform');
  }

  if (config.ENABLE_THREADS && !config.THREADS_ACCESS_TOKEN) {
    missing.push('THREADS_ACCESS_TOKEN');
  }

  if (config.ENABLE_X && !hasXOAuth1 && !hasXOAuth2 && !canStartXOAuth2) {
    missing.push('X OAuth credentials: X_OAUTH2_ACCESS_TOKEN, X_CLIENT_ID/X_CLIENT_SECRET, or X_API_KEY/X_API_SECRET/X_ACCESS_TOKEN/X_ACCESS_TOKEN_SECRET');
  }

  if (config.ENABLE_INSTAGRAM) {
    if (!config.FACEBOOK_PAGE_ACCESS_TOKEN && !config.META_ACCESS_TOKEN) {
      missing.push('FACEBOOK_PAGE_ACCESS_TOKEN or META_ACCESS_TOKEN');
    }
    if (!config.INSTAGRAM_ACCOUNT_ID && !config.FACEBOOK_PAGE_ID) {
      missing.push('INSTAGRAM_ACCOUNT_ID or FACEBOOK_PAGE_ID');
    }
    if (!config.CLOUDINARY_CLOUD_NAME || !hasCloudinaryAuth) {
      missing.push('CLOUDINARY_CLOUD_NAME plus CLOUDINARY_UPLOAD_PRESET or CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET');
    }
  }

  if (config.ENABLE_LINKEDIN) {
    if (!config.LINKEDIN_TOKEN) missing.push('LINKEDIN_TOKEN');
    if (!config.LINKEDIN_PERSON_URN) missing.push('LINKEDIN_PERSON_URN');
  }

  if (config.ENABLE_FACEBOOK) {
    if (!config.META_ACCESS_TOKEN) missing.push('META_ACCESS_TOKEN');
    if (!config.FACEBOOK_GROUP_ID) missing.push('FACEBOOK_GROUP_ID');
  }

  return {
    ready: missing.length === 0,
    missing,
    enabledPlatforms,
  };
}

export function getAutomationGate(): AutomationGate {
  const readiness = getRuntimeReadiness();
  const localBillingBypassActive = isLocalDevBillingBypassActive();
  const billing = localBillingBypassActive
    ? getBillingStateSnapshot()
    : getBillingState();
  const billingAccessActive = canAccessAutomation();
  const ownerReady = hasUsers();
  const reasons: string[] = [];

  if (!ownerReady) {
    reasons.push('Owner account has not been bootstrapped');
  }

  if (!billingAccessActive) {
    reasons.push(
      billing.lockedReason
        || `Billing status ${billing.status} does not allow automation`
    );
  }

  if (!readiness.ready) {
    reasons.push(`Runtime is missing: ${readiness.missing.join(', ')}`);
  }

  if (!billingAccessActive && billing.accessActive) {
    reasons.push('Automation access is disabled');
  }

  return {
    allowed: ownerReady && billingAccessActive && readiness.ready,
    reasons,
    readiness,
    billing,
    billingAccessActive,
    localBillingBypassActive,
    hasOwner: ownerReady,
  };
}
