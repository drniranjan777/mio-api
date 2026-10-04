import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { ApiError } from '../../utils/ApiError.js';
import { inspectImage } from './image.js';

/**
 * Image storage on local disk (UPLOADS_DIR), served at /uploads/<key>.
 * The database stores only the key (e.g. "banners/3f…a1.webp"); public URLs
 * are built from PUBLIC_BASE_URL at response time, so a domain change never
 * requires a data migration. Swap this module for S3 / object storage later.
 */

export const UPLOAD_ROUTE = '/uploads';

/** Rules per image purpose. */
export const IMAGE_RULES = Object.freeze({
  banner: {
    folder: 'banners',
    maxBytes: 2 * 1024 * 1024,
    minWidth: 720,
    minHeight: 300,
    maxWidth: 4000,
    maxHeight: 4000,
    // The app shows banners at 358:162 (≈2.2:1); allow some slack for crops.
    minRatio: 1.6,
    maxRatio: 3.2,
  },
});

const root = () => path.resolve(env.UPLOADS_DIR);
const KEY_RE = /^[a-z]+\/[a-f0-9]{32}\.(png|jpg|webp)$/;

export const isUploadKey = (key) => typeof key === 'string' && KEY_RE.test(key);

export function publicUrl(key) {
  return isUploadKey(key) ? `${env.publicBaseUrl}${UPLOAD_ROUTE}/${key}` : null;
}

/** Validates and stores an image; returns `{ key, url, width, height, bytes, mime }`. */
export async function saveImage(buffer, purpose) {
  const rules = IMAGE_RULES[purpose];
  if (!rules) throw ApiError.badRequest('Unknown upload purpose', undefined, 'UPLOAD_PURPOSE');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw ApiError.badRequest('No image received', undefined, 'UPLOAD_EMPTY');
  }
  if (buffer.length > rules.maxBytes) {
    throw ApiError.badRequest(`Image is larger than ${rules.maxBytes / 1024 / 1024} MB`, undefined, 'UPLOAD_TOO_LARGE');
  }
  const info = inspectImage(buffer);
  if (!info) throw ApiError.badRequest('Use a JPG, PNG or WEBP image', undefined, 'UPLOAD_TYPE');

  const { width, height } = info;
  const ratio = width / height;
  if (width < rules.minWidth || height < rules.minHeight) {
    throw ApiError.badRequest(`Image is ${width}×${height}px; at least ${rules.minWidth}×${rules.minHeight}px is needed`, undefined, 'UPLOAD_TOO_SMALL');
  }
  if (width > rules.maxWidth || height > rules.maxHeight) {
    throw ApiError.badRequest(`Image is ${width}×${height}px; at most ${rules.maxWidth}×${rules.maxHeight}px is allowed`, undefined, 'UPLOAD_TOO_BIG');
  }
  if (ratio < rules.minRatio || ratio > rules.maxRatio) {
    throw ApiError.badRequest(
      `Image shape is ${ratio.toFixed(2)}:1; banners must be wide, between ${rules.minRatio}:1 and ${rules.maxRatio}:1 (e.g. 1080×490)`,
      undefined,
      'UPLOAD_RATIO',
    );
  }

  const key = `${rules.folder}/${crypto.randomBytes(16).toString('hex')}.${info.ext}`;
  const file = path.join(root(), key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, buffer, { flag: 'wx', mode: 0o644 });
  return { key, url: publicUrl(key), width, height, bytes: buffer.length, mime: info.mime };
}

export async function imageExists(key) {
  if (!isUploadKey(key)) return false;
  try {
    await fs.access(path.join(root(), key));
    return true;
  } catch {
    return false;
  }
}

/** Removes a stored image; missing files are ignored (never throws). */
export async function deleteImage(key) {
  if (!isUploadKey(key)) return;
  try {
    await fs.unlink(path.join(root(), key));
  } catch (err) {
    if (err?.code !== 'ENOENT') logger.warn({ err, key }, 'Could not delete uploaded image');
  }
}
