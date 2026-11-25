const PREFIX = '[SCF]';

/**
 * Info/debug logs are off by default: DevTools retains every logged object,
 * which grows memory and slows Chrome during long playback sessions.
 * Set `SCF_DEBUG = true` in the console (page or extension context) to enable.
 */
function debugEnabled(): boolean {
  return (globalThis as { SCF_DEBUG?: boolean }).SCF_DEBUG === true;
}

export const logger = {
  info: (...args: unknown[]) => {
    if (debugEnabled()) console.info(PREFIX, ...args);
  },
  warn: (...args: unknown[]) => console.warn(PREFIX, ...args),
  error: (...args: unknown[]) => console.error(PREFIX, ...args),
  debug: (...args: unknown[]) => {
    if (debugEnabled()) console.debug(PREFIX, ...args);
  },
};
