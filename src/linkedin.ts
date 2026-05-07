import config from '../config';
import { requestJson } from './http-client';

interface LinkedInPublishSuccess {
  id?: string;
}

interface LinkedInPublishError {
  message?: string;
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
  }).then(({ status, data }) => {
    if (status === 201) {
      return data.id || 'posted';
    }
    throw new Error('LinkedIn API: ' + (data.message || `HTTP ${status}`));
  });
}
