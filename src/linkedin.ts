import config from '../config';
import { isHttpError } from './errors';
import { requestJson } from './http-client';
import {
  isPlatformPublishError,
  PlatformPublishError,
  safeBodySnippet,
} from './platform-errors';

interface LinkedInPublishSuccess {
  id?: string;
}

interface LinkedInPublishError {
  message?: string;
  code?: string;
  serviceErrorCode?: number;
  status?: number;
}

interface LinkedInPublishResponse extends LinkedInPublishSuccess {
  message?: string;
}

export function publish(text: string): Promise<string> {
  if (!config.LINKEDIN_TOKEN || !config.LINKEDIN_PERSON_URN) {
    throw new Error('LINKEDIN_TOKEN or LINKEDIN_PERSON_URN not set');
  }

  if (!text || !text.trim()) {
    throw new Error('LinkedIn post text is empty');
  }

  const payload = JSON.stringify({
    author: config.LINKEDIN_PERSON_URN,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: 'NONE',
      },
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
    },
  });

  return requestJson<LinkedInPublishResponse>('https://api.linkedin.com/v2/ugcPosts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.LINKEDIN_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: payload,
    timeoutMs: config.HTTP_TIMEOUT_MS,
  }).then(({ status, headers, data, rawText }) => {
    if (status === 201) {
      return data.id || 'posted';
    }
    throw normalizeLinkedInError('post', status, headers.get('content-type'), rawText, data);
  }).catch(error => {
    if (isPlatformPublishError(error)) throw error;
    if (isHttpError(error) && error.code === 'UPSTREAM_PARSE_ERROR') {
      throw new PlatformPublishError({
        platform: 'linkedin',
        stage: 'post',
        code: 'unexpected_response',
        userMessage: 'LinkedIn returned an unexpected response. Check token validity, permissions, and payload format.',
        nextAction: 'Reconnect LinkedIn or inspect Logs for the safe response details, then retry publish.',
        status: typeof error.details?.status === 'number' ? error.details.status : error.status,
        contentType: typeof error.details?.contentType === 'string' ? error.details.contentType : null,
        bodySnippet: typeof error.details?.bodySnippet === 'string' ? error.details.bodySnippet : null,
      });
    }
    throw error;
  });
}

function normalizeLinkedInError(
  stage: string,
  status: number,
  contentType: string | null,
  rawText: string,
  data: LinkedInPublishError
): PlatformPublishError {
  const message = data.message || `HTTP ${status}`;
  const code = data.code || (data.serviceErrorCode ? String(data.serviceErrorCode) : undefined);
  if (status === 401 || data.code === 'INVALID_ACCESS_TOKEN') {
    return new PlatformPublishError({
      platform: 'linkedin',
      stage,
      code: 'needs_reconnect',
      userMessage: 'LinkedIn credentials are invalid or expired. Reconnect LinkedIn and try again.',
      nextAction: 'Reconnect LinkedIn in Credentials, then retry publish.',
      status,
      contentType,
      providerCode: code,
      bodySnippet: safeBodySnippet(rawText),
    });
  }

  return new PlatformPublishError({
    platform: 'linkedin',
    stage,
    code: status === 400 ? 'payload_rejected' : 'platform_api_error',
    userMessage: status === 400
      ? 'LinkedIn rejected the draft payload. Check text and account permissions.'
      : `LinkedIn API error: ${message}`,
    nextAction: 'Open Logs for the LinkedIn API details, then retry after fixing the account.',
    status,
    contentType,
    providerCode: code,
    bodySnippet: safeBodySnippet(rawText),
  });
}
