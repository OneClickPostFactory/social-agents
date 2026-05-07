import * as crypto from 'node:crypto';

import config from '../config';

const ENC_PREFIX = 'enc:v1:';
const GCM_TAG_BYTES = 16;
const GCM_IV_BYTES = 12;

export interface TenantCredentials {
  openaiApiKey?: string;
  threadsToken?: string;
  instagramToken?: string;
  instagramAccountId?: string;
  facebookPageId?: string;
  facebookPageAccessToken?: string;
  linkedinToken?: string;
  linkedinPersonUrn?: string;
  metaAccessToken?: string;
  redditClientId?: string;
  redditClientSecret?: string;
  xClientId?: string;
  xClientSecret?: string;
  xOAuth2AccessToken?: string;
  xOAuth2RefreshToken?: string;
}

export interface TenantCredentialRow {
  openai_api_key_enc?: string | null;
  threads_token_enc?: string | null;
  instagram_token_enc?: string | null;
  instagram_account_id_enc?: string | null;
  facebook_token_enc?: string | null;
  facebook_page_id_enc?: string | null;
  facebook_page_access_token_enc?: string | null;
  linkedin_token_enc?: string | null;
  linkedin_person_urn_enc?: string | null;
  meta_access_token_enc?: string | null;
  reddit_client_id_enc?: string | null;
  reddit_client_secret_enc?: string | null;
  x_client_id_enc?: string | null;
  x_client_secret_enc?: string | null;
  x_oauth2_access_token_enc?: string | null;
  x_oauth2_refresh_token_enc?: string | null;
}

function key(): Buffer {
  if (!config.CREDENTIAL_ENCRYPTION_KEY) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY is not configured');
  }
  return crypto.createHash('sha256').update(config.CREDENTIAL_ENCRYPTION_KEY).digest();
}

function normalizeStoredValue(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const value = String(stored);
  if (value.startsWith(ENC_PREFIX)) return value;

  if (value.startsWith('\\x')) {
    const decoded = Buffer.from(value.slice(2), 'hex').toString('utf8');
    return decoded || value;
  }

  return value;
}

export function decryptCredential(stored: string | null | undefined): string | null {
  const normalized = normalizeStoredValue(stored);
  if (!normalized) return null;
  if (!normalized.startsWith(ENC_PREFIX)) {
    return normalized;
  }

  const combined = Buffer.from(normalized.slice(ENC_PREFIX.length), 'base64');
  if (combined.length <= GCM_IV_BYTES + GCM_TAG_BYTES) {
    throw new Error('encrypted credential payload is malformed');
  }

  const iv = combined.subarray(0, GCM_IV_BYTES);
  const ciphertextWithTag = combined.subarray(GCM_IV_BYTES);
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - GCM_TAG_BYTES);
  const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - GCM_TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

export function encryptCredential(value: string): string {
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, ciphertext, authTag]).toString('base64');
}

function compact(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function decryptTenantCredentials(row: TenantCredentialRow | null | undefined): TenantCredentials {
  if (!row) return {};

  try {
    return {
      openaiApiKey: compact(decryptCredential(row.openai_api_key_enc)),
      threadsToken: compact(decryptCredential(row.threads_token_enc)),
      instagramToken: compact(decryptCredential(row.instagram_token_enc)),
      instagramAccountId: compact(decryptCredential(row.instagram_account_id_enc)),
      facebookPageId: compact(decryptCredential(row.facebook_page_id_enc)),
      facebookPageAccessToken: compact(decryptCredential(row.facebook_page_access_token_enc)),
      linkedinToken: compact(decryptCredential(row.linkedin_token_enc)),
      linkedinPersonUrn: compact(decryptCredential(row.linkedin_person_urn_enc)),
      metaAccessToken: compact(decryptCredential(row.meta_access_token_enc)),
      redditClientId: compact(decryptCredential(row.reddit_client_id_enc)),
      redditClientSecret: compact(decryptCredential(row.reddit_client_secret_enc)),
      xClientId: compact(decryptCredential(row.x_client_id_enc)),
      xClientSecret: compact(decryptCredential(row.x_client_secret_enc)),
      xOAuth2AccessToken: compact(decryptCredential(row.x_oauth2_access_token_enc)),
      xOAuth2RefreshToken: compact(decryptCredential(row.x_oauth2_refresh_token_enc)),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`credential_decryption_failed: ${message}`);
  }
}
