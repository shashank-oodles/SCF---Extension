import type { TitleFilterConfig } from '../types';

export function validateTitleFilterConfig(
  config: unknown
): config is TitleFilterConfig {
  if (!config || typeof config !== 'object') return false;

  const c = config as TitleFilterConfig;
  if (typeof c.titleId !== 'string' || !c.titleId) return false;
  if (typeof c.title !== 'string' || !c.title) return false;
  if (!Array.isArray(c.filters) || !Array.isArray(c.matchPatterns)) return false;

  return c.filters.every(
    (f) =>
      typeof f.id === 'string' &&
      typeof f.start === 'number' &&
      typeof f.end === 'number' &&
      f.end > f.start &&
      (f.action === 'mute' || f.action === 'skip')
  );
}
