// ─────────────────────────────────────────────────────────────────────────────
// Profile pictures.
//
// TJ is the default and the only photo. The rest of the Recess gang are
// original drawings in public/avatars — a nod to each character's signature
// look rather than frames from the show. A picture you upload is stored by the
// server in the data directory and served back through /api/avatar.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';

export const DEFAULT_AVATAR = 'tj';
export const CUSTOM_AVATAR = 'custom';

export const AVATARS = [
  { id: 'tj', label: 'TJ', src: '/tj.png' },
  { id: 'spinelli', label: 'Spinelli', src: '/avatars/spinelli.svg' },
  { id: 'gretchen', label: 'Gretchen', src: '/avatars/gretchen.svg' },
  { id: 'gus', label: 'Gus', src: '/avatars/gus.svg' },
  { id: 'vince', label: 'Vince', src: '/avatars/vince.svg' },
  { id: 'mikey', label: 'Mikey', src: '/avatars/mikey.svg' },
  { id: 'king-bob', label: 'King Bob', src: '/avatars/king-bob.svg' },
  { id: 'finster', label: 'Miss Finster', src: '/avatars/finster.svg' },
];

const AVATAR_EVENT = 'tsb:avatar-changed';

export function presetAvatar(id) {
  return AVATARS.find(a => a.id === id) || AVATARS[0];
}

/** Tell every mounted avatar to re-read the choice. */
export function announceAvatarChange() {
  window.dispatchEvent(new CustomEvent(AVATAR_EVENT));
}

/**
 * Fetch the uploaded picture as an object URL.
 *
 * An <img src="/api/avatar"> would go out without the API token and get a 401,
 * so it is fetched (the fetch shim adds the token) and handed over as a blob.
 */
export async function loadCustomAvatar() {
  const res = await fetch('/api/avatar');
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}

/**
 * Downscale and centre-crop a picked file to a square JPEG data URL.
 *
 * A phone photo is several megabytes and thousands of pixels wide; the avatar
 * never renders above ~80px, so 256px keeps it sharp on a retina screen at a
 * few tens of kilobytes.
 */
export function squareImage(file, size = 256) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      canvas.getContext('2d').drawImage(
        img,
        (img.naturalWidth - side) / 2,
        (img.naturalHeight - side) / 2,
        side,
        side,
        0,
        0,
        size,
        size,
      );
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file is not an image this browser can read'));
    };
    img.src = url;
  });
}

/** The current profile picture as `{ id, label, src }`, kept live across changes. */
export function useProfileAvatar() {
  const [avatar, setAvatar] = useState(presetAvatar(DEFAULT_AVATAR));

  useEffect(() => {
    let objectUrl = null;
    let cancelled = false;

    async function refresh() {
      let id = DEFAULT_AVATAR;
      let settingsHaveUpload = false;
      try {
        const settings = await (await fetch('/api/settings')).json();
        id = settings?.avatar || DEFAULT_AVATAR;
        settingsHaveUpload = !!settings?.avatarUploaded;
      } catch {
        // Settings unreachable — the default picture is still a picture.
      }

      if (id === CUSTOM_AVATAR && settingsHaveUpload) {
        const src = await loadCustomAvatar().catch(() => null);
        if (cancelled) { if (src) URL.revokeObjectURL(src); return; }
        if (src) {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = src;
          setAvatar({ id, label: 'Your picture', src });
          return;
        }
        id = DEFAULT_AVATAR;
      }
      if (!cancelled) setAvatar(presetAvatar(id));
    }

    refresh();
    window.addEventListener(AVATAR_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(AVATAR_EVENT, refresh);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, []);

  return avatar;
}
