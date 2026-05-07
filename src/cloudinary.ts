import * as crypto from 'node:crypto';

import config from '../config';

import { requestJson } from './http-client';

interface CloudinaryUploadResponse {
  secure_url?: string;
  url?: string;
  public_id?: string;
  error?: {
    message?: string;
  };
}

export function isConfigured(): boolean {
  return Boolean(
    config.CLOUDINARY_CLOUD_NAME
    && (
      config.CLOUDINARY_UPLOAD_PRESET
      || (config.CLOUDINARY_API_KEY && config.CLOUDINARY_API_SECRET)
    )
  );
}

export function isCloudinaryUrl(value: string | undefined): boolean {
  if (!value) return false;

  try {
    return new URL(value).hostname.endsWith('.cloudinary.com');
  } catch {
    return false;
  }
}

export async function uploadRemoteImage(imageUrl: string, publicIdHint?: string): Promise<string> {
  if (!isConfigured()) {
    throw new Error(
      'Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME plus CLOUDINARY_UPLOAD_PRESET or CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET.'
    );
  }

  const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(config.CLOUDINARY_CLOUD_NAME)}/image/upload`;
  const params = new URLSearchParams();
  params.set('file', imageUrl);

  if (config.CLOUDINARY_FOLDER) {
    params.set('folder', config.CLOUDINARY_FOLDER);
  }

  if (publicIdHint) {
    params.set('public_id', `${sanitizePublicId(publicIdHint)}-${Date.now().toString(36)}`);
  }

  if (config.CLOUDINARY_UPLOAD_PRESET) {
    params.set('upload_preset', config.CLOUDINARY_UPLOAD_PRESET);
  } else {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    params.set('timestamp', timestamp);
    params.set('api_key', config.CLOUDINARY_API_KEY);
    params.set('signature', signUploadParams(params));
  }

  const { data } = await requestJson<CloudinaryUploadResponse>(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    timeoutMs: Math.max(config.HTTP_TIMEOUT_MS, 60000),
  });

  if (data.error) {
    throw new Error('Cloudinary: ' + (data.error.message || 'Upload failed'));
  }

  const secureUrl = data.secure_url || data.url;
  if (!secureUrl) {
    throw new Error('Cloudinary: Upload response did not include a delivery URL');
  }

  return secureUrl;
}

function signUploadParams(params: URLSearchParams): string {
  const excluded = new Set(['api_key', 'file', 'resource_type', 'cloud_name', 'signature']);
  const payload = [...params.entries()]
    .filter(([key, value]) => !excluded.has(key) && value !== '')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  return crypto
    .createHash('sha1')
    .update(`${payload}${config.CLOUDINARY_API_SECRET}`)
    .digest('hex');
}

function sanitizePublicId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
