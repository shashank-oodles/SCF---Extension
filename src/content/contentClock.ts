/**
 * Maps the <video> element's clock to the title's content clock.
 *
 * Prime stitches ads into the same media timeline, so `video.currentTime`
 * can run ahead of the title time shown in the player UI. Filters are
 * stored in content time; we estimate offset = videoTime - contentTime from
 * the player's time indicator and keep it between UI updates.
 */

import { WATCH_PLAYER_ROOT_SELECTOR } from './playbackVideo';

const AD_SELECTORS =
  '.atvwebplayersdk-ad-timer, .atvwebplayersdk-adtimeindicator-text';

const TIME_INDICATOR_SELECTOR = '.atvwebplayersdk-timeindicator-text';

/** Displayed time is floored to whole seconds, so samples jitter by <1s. */
const SEGMENT_JUMP_S = 2;
const SAMPLE_CACHE_MS = 500;

let offset = 0;
let lastDisplayed: number | null = null;
let cachedAd: { at: number; value: boolean } | null = null;
let lastSampledAt = 0;

function playerRoot(): ParentNode {
  return document.querySelector(WATCH_PLAYER_ROOT_SELECTOR) ?? document;
}

export function parseClock(text: string): number | null {
  const match = text.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = match[1] ? Number(match[1]) : 0;
  return h * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function isAdPlaying(): boolean {
  const now = Date.now();
  if (cachedAd && now - cachedAd.at < SAMPLE_CACHE_MS) {
    return cachedAd.value;
  }
  const el = playerRoot().querySelector(AD_SELECTORS);
  const value = Boolean(el && (el.textContent || '').trim());
  cachedAd = { at: now, value };
  return value;
}

function readDisplayedContentTime(): number | null {
  const text = playerRoot().querySelector(TIME_INDICATOR_SELECTOR)?.textContent;
  if (!text || !text.includes('/')) return null;
  return parseClock(text.split('/')[0]);
}

function sampleOffset(video: HTMLVideoElement): void {
  const now = Date.now();
  if (now - lastSampledAt < SAMPLE_CACHE_MS) return;
  lastSampledAt = now;

  if (isAdPlaying()) return;
  const displayed = readDisplayedContentTime();
  if (displayed == null) return;

  const estimate = video.currentTime - displayed;
  if (lastDisplayed == null || Math.abs(estimate - offset) > SEGMENT_JUMP_S) {
    // New ad break boundary or first sample
    offset = estimate;
  } else {
    // Floor jitter only ever overestimates; the smallest sample is closest.
    offset = Math.min(offset, estimate);
  }
  lastDisplayed = displayed;
}

export function contentTimeOf(video: HTMLVideoElement): number {
  sampleOffset(video);
  return Math.max(0, video.currentTime - offset);
}

export function videoTimeFor(contentTime: number): number {
  return contentTime + offset;
}

export function resetContentClock(): void {
  offset = 0;
  lastDisplayed = null;
  cachedAd = null;
  lastSampledAt = 0;
}
