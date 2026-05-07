import config from '../config';
import { requestJson } from './http-client';

interface GraphSuccess {
  id: string;
}

interface GraphErrorResponse {
  error?: {
    message?: string;
  };
  id?: string;
}

export async function publish(text: string): Promise<string> {
  const token = config.THREADS_ACCESS_TOKEN;

  if (!token) {
    throw new Error('THREADS_ACCESS_TOKEN not set');
  }

  if (!text || !text.trim()) {
    throw new Error('Threads post text is empty');
  }

  const containerId = await apiPost(
    '/me/threads',
    { media_type: 'TEXT', text, access_token: token }
  );

  await sleep(2000);

  return apiPost(
    '/me/threads_publish',
    { creation_id: containerId, access_token: token }
  );
}

function apiPost(pathname: string, params: Record<string, string>): Promise<string> {
  const token = params.access_token;
  const body = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'access_token'))
  ).toString();

  return requestJson<GraphErrorResponse & GraphSuccess>(`https://graph.threads.net${pathname}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    timeoutMs: config.HTTP_TIMEOUT_MS,
  }).then(({ data }) => {
    if (data.error) {
      throw new Error('Threads API: ' + (data.error.message || 'Unknown error'));
    }
    return data.id;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
