import express from 'express';

/** Raw image body parser (no multipart needed); the bytes are checked in saveImage. */
export const rawImage = () =>
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'], limit: '3mb' });
