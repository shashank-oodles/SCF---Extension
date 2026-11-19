import type { PlaybackSnapshot } from '../types';
import { logger } from '../utils/logger';

export type PlaybackEventName =
  | 'play'
  | 'pause'
  | 'timeupdate'
  | 'seeking'
  | 'seeked'
  | 'ended'
  | 'ratechange'
  | 'waiting'
  | 'playing';

export type PlaybackHandler = (
  event: PlaybackEventName,
  snapshot: PlaybackSnapshot
) => void;

const MEDIA_EVENTS: PlaybackEventName[] = [
  'play',
  'pause',
  'timeupdate',
  'seeking',
  'seeked',
  'ended',
  'ratechange',
  'waiting',
  'playing',
];

/**
 * Attaches media event listeners to a video element and exposes playback state.
 * Prefer media events over rAF so background-tab throttling is less severe.
 */
export class PlaybackMonitor {
  private video: HTMLVideoElement | null = null;
  private waiting = false;
  private readonly handlers = new Set<PlaybackHandler>();
  private readonly boundListeners = new Map<
    PlaybackEventName,
    EventListener
  >();

  subscribe(handler: PlaybackHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  attach(video: HTMLVideoElement): void {
    if (this.video === video) return;
    this.detach();
    this.video = video;
    this.waiting = false;

    for (const name of MEDIA_EVENTS) {
      const listener: EventListener = () => {
        if (name === 'waiting') this.waiting = true;
        if (name === 'playing' || name === 'seeked') this.waiting = false;
        this.emit(name);
      };
      this.boundListeners.set(name, listener);
      video.addEventListener(name, listener);
    }

    logger.info('PlaybackMonitor attached');
    // Emit an initial snapshot so filters can sync immediately
    this.emit('timeupdate');
  }

  detach(): void {
    if (!this.video) return;

    for (const [name, listener] of this.boundListeners) {
      this.video.removeEventListener(name, listener);
    }
    this.boundListeners.clear();
    this.video = null;
    this.waiting = false;
    logger.info('PlaybackMonitor detached');
  }

  getSnapshot(): PlaybackSnapshot | null {
    if (!this.video) return null;
    return this.buildSnapshot(this.video);
  }

  getVideo(): HTMLVideoElement | null {
    return this.video;
  }

  private buildSnapshot(video: HTMLVideoElement): PlaybackSnapshot {
    return {
      currentTime: video.currentTime,
      paused: video.paused,
      seeking: video.seeking,
      playbackRate: video.playbackRate,
      readyState: video.readyState,
      ended: video.ended,
      waiting: this.waiting,
    };
  }

  private emit(event: PlaybackEventName): void {
    if (!this.video) return;
    const snapshot = this.buildSnapshot(this.video);
    for (const handler of this.handlers) {
      try {
        handler(event, snapshot);
      } catch (err) {
        logger.error('Playback handler error', err);
      }
    }
  }
}
