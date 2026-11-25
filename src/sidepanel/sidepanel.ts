import type { FilterAction, FilterInterval, ExtensionStatus } from '../types';
import type { SidePanelState } from '../types/panel';
import {
  appendFiltersForTitle,
  tryResolveFiltersByQuery,
} from '../services/filterApi';

const statusPill = document.getElementById('status-pill') as HTMLDivElement;
const detectedKind = document.getElementById('detected-kind') as HTMLParagraphElement;
const detectedTitle = document.getElementById('detected-title') as HTMLParagraphElement;
const detectedMeta = document.getElementById('detected-meta') as HTMLParagraphElement;
const episodesCard = document.getElementById('episodes-card') as HTMLElement;
const episodesDetail = document.getElementById('episodes-detail') as HTMLParagraphElement;
const episodeList = document.getElementById('episode-list') as HTMLDivElement;

const markCard = document.getElementById('mark-card') as HTMLElement;
const markClock = document.getElementById('mark-clock') as HTMLParagraphElement;
const inputFrom = document.getElementById('input-from') as HTMLInputElement;
const inputTo = document.getElementById('input-to') as HTMLInputElement;
const btnMarkStart = document.getElementById('btn-mark-start') as HTMLButtonElement;
const btnMarkEnd = document.getElementById('btn-mark-end') as HTMLButtonElement;
const btnSaveFilter = document.getElementById('btn-save-filter') as HTMLButtonElement;
const markLabelInput = document.getElementById('mark-label') as HTMLInputElement;
const markStatus = document.getElementById('mark-status') as HTMLParagraphElement;
const savedCard = document.getElementById('saved-card') as HTMLElement;
const savedDetail = document.getElementById('saved-detail') as HTMLParagraphElement;
const savedList = document.getElementById('saved-list') as HTMLUListElement;

let latestState: SidePanelState | null = null;
let pendingStart: number | null = null;
let pendingEnd: number | null = null;
let savedFilters: FilterInterval[] = [];
let loadingKey = '';
let lastAuthorGti = '';
let saving = false;
let fetchingTime: 'start' | 'end' | null = null;

/** Stop spinning if Prime never delivers (e.g. GTI not exposed on this page). */
const LOADER_TIMEOUT_MS = 8_000;
const waitingSince = new Map<string, number>();

function isStillWaiting(key: string): boolean {
  const started = waitingSince.get(key);
  if (started == null) {
    waitingSince.set(key, Date.now());
    window.setTimeout(() => {
      if (!latestState) return;
      lastRenderSignature = '';
      render(latestState);
    }, LOADER_TIMEOUT_MS + 50);
    return true;
  }
  return Date.now() - started < LOADER_TIMEOUT_MS;
}

function loaderHtml(text: string): string {
  return `<span class="loader"><span class="spinner" aria-hidden="true"></span>${escapeHtml(
    text
  )}</span>`;
}

function setButtonLoading(
  btn: HTMLButtonElement,
  loading: boolean,
  idleLabel: string,
  loadingLabel: string
): void {
  if (loading) {
    btn.innerHTML = `<span class="btn-loading"><span class="spinner" aria-hidden="true"></span>${escapeHtml(
      loadingLabel
    )}</span>`;
  } else if (btn.textContent !== idleLabel) {
    btn.textContent = idleLabel;
  }
}

function pillClass(status: ExtensionStatus): string {
  if (
    status === 'filtering_active' ||
    status === 'filters_loaded' ||
    status === 'video_detected'
  ) {
    return 'pill pill-ok';
  }
  if (status === 'backend_failed') return 'pill pill-danger';
  if (status === 'title_not_matched' || status === 'awaiting_selection') {
    return 'pill pill-warn';
  }
  return 'pill pill-neutral';
}

function statusLabel(status: ExtensionStatus, playerOpen: boolean): string {
  if (!playerOpen) {
    switch (status) {
      case 'awaiting_selection':
        return 'Pick episode';
      case 'title_not_matched':
        return 'No title';
      case 'backend_failed':
        return 'Error';
      case 'initialized':
        return 'Waiting';
      default:
        return 'Detected';
    }
  }

  switch (status) {
    case 'filters_loaded':
    case 'video_detected':
      return 'Ready';
    case 'filtering_active':
      return 'Playing';
    case 'awaiting_selection':
      return 'Pick episode';
    case 'title_not_matched':
      return 'No title';
    case 'backend_failed':
      return 'Error';
    default:
      return 'Playing';
  }
}

function kindLabel(kind: string): string {
  if (kind === 'movie') return 'Movie';
  if (kind === 'show') return 'TV show';
  return 'Title';
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function selectedAction(): FilterAction {
  const checked = document.querySelector(
    'input[name="filter-action"]:checked'
  ) as HTMLInputElement | null;
  return checked?.value === 'skip' ? 'skip' : 'mute';
}

function activeEpisode(state: SidePanelState): string | null {
  return state.selectedEpisode || state.detected?.episodeName || null;
}

function activeGti(state: SidePanelState): string | null {
  return state.selectedGti || state.detected?.gti || null;
}

function canAuthor(state: SidePanelState): boolean {
  return Boolean(activeGti(state));
}

function clearPendingMarks(): void {
  pendingStart = null;
  pendingEnd = null;
  inputFrom.value = '';
  inputTo.value = '';
  inputFrom.classList.remove('invalid');
  inputTo.classList.remove('invalid');
}

/** Accepts "75", "10:14", "1:02:03" (optionally with fractional seconds). */
function parseTimeInput(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const parts = text.split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) {
    return null;
  }
  const nums = parts.map(Number);
  if (nums.slice(1).some((n) => n >= 60)) return null;
  return nums.reduce((total, n) => total * 60 + n, 0);
}

function onTimeInput(input: HTMLInputElement, which: 'start' | 'end'): void {
  const value = parseTimeInput(input.value);
  input.classList.toggle('invalid', Boolean(input.value.trim()) && value == null);
  if (which === 'start') pendingStart = value;
  else pendingEnd = value;
  if (latestState) updateMarkControls(latestState);
}

function setMarkStatus(
  message: string,
  kind: 'ok' | 'error' | 'muted' = 'muted'
): void {
  markStatus.hidden = !message;
  markStatus.textContent = message;
  markStatus.className =
    kind === 'ok'
      ? 'muted mark-status ok'
      : kind === 'error'
        ? 'muted mark-status error'
        : 'muted mark-status';
}

function updateMarkControls(state: SidePanelState): void {
  const playerOpen = Boolean(state.playerOpen);
  const authorable = canAuthor(state);
  const t = typeof state.currentTime === 'number' ? state.currentTime : null;

  // Authoring only makes sense while a specific movie/episode is playing.
  markCard.hidden = !authorable || !playerOpen;
  if (markCard.hidden) return;

  const adPlaying = Boolean(state.adPlaying);
  markClock.classList.toggle('ad', adPlaying);
  markClock.textContent = adPlaying
    ? 'Ad playing — filters paused'
    : t != null
      ? formatTime(t)
      : '--:--';

  btnMarkStart.disabled = saving || adPlaying || fetchingTime != null;
  btnMarkEnd.disabled = saving || adPlaying || fetchingTime != null;
  setButtonLoading(btnMarkStart, fetchingTime === 'start', 'Now', '');
  setButtonLoading(btnMarkEnd, fetchingTime === 'end', 'Now', '');
  setButtonLoading(btnSaveFilter, saving, 'Save mute / skip filter', 'Saving…');

  const ready =
    pendingStart != null &&
    pendingEnd != null &&
    pendingEnd > pendingStart &&
    !saving;
  btnSaveFilter.disabled = !ready;
}

function renderSavedFilters(
  filters: FilterInterval[],
  contextLabel: string
): void {
  savedFilters = filters;
  savedCard.hidden = false;
  savedDetail.textContent =
    filters.length === 0
      ? `${contextLabel} · no filters yet`
      : `${contextLabel} · ${filters.length} filter${
          filters.length === 1 ? '' : 's'
        }`;

  if (filters.length === 0) {
    savedList.innerHTML = `<li class="empty-row"><span>No mute/skip ranges saved for this title yet.</span></li>`;
    return;
  }

  savedList.innerHTML = filters
    .map(
      (f) => `
      <li>
        <span>${escapeHtml(f.label || f.id)} · ${formatTime(f.start)}–${formatTime(
          f.end
        )}</span>
        <span class="action">${escapeHtml(f.action)}</span>
      </li>`
    )
    .join('');
}

async function refreshSavedFilters(
  state: SidePanelState,
  force = false
): Promise<void> {
  const gti = activeGti(state);
  if (!gti || !state.playerOpen) {
    loadingKey = '';
    savedCard.hidden = true;
    savedList.innerHTML = '';
    return;
  }

  const episode = activeEpisode(state);
  const title = state.detected?.title || 'Title';
  const contextLabel =
    state.detected?.kind === 'show' && episode
      ? `${title} · ${episode}`
      : title;

  const stableKey = `gti|${gti}`;
  if (!force && stableKey === loadingKey) return;
  loadingKey = stableKey;

  savedCard.hidden = false;
  savedDetail.textContent = contextLabel;
  savedList.innerHTML = `<li class="loader-row"><span class="spinner" aria-hidden="true"></span>Loading your filters…</li>`;

  try {
    const config = await tryResolveFiltersByQuery(gti);
    if (loadingKey !== stableKey) return;
    renderSavedFilters(config?.filters ?? [], contextLabel);
  } catch {
    if (loadingKey !== stableKey) return;
    renderSavedFilters([], contextLabel);
    setMarkStatus('Could not load saved filters (is the backend running?)', 'error');
  }
}

function notifyContentFiltersChanged(gti: string): void {
  void chrome.runtime.sendMessage({
    type: 'SCF_FILTERS_CHANGED',
    gti,
  });
}

let lastRenderSignature = '';

function renderSignature(state: SidePanelState): string {
  const d = state.detected;
  return JSON.stringify([
    state.playerOpen,
    state.status,
    state.statusDetail,
    state.selectedEpisode,
    state.selectedGti,
    d?.kind,
    d?.title,
    d?.episodeName,
    d?.seasonLabel,
    d?.gti,
    d?.episodes.map((e) => `${e.titleId || ''}:${e.name}:${e.nowPlaying ? 1 : 0}`),
  ]);
}

function render(state: SidePanelState): void {
  latestState = state;

  // Full DOM rebuild only when something visible changed.
  const signature = renderSignature(state);
  if (signature === lastRenderSignature) {
    updateMarkControls(state);
    return;
  }
  lastRenderSignature = signature;

  const playerOpen = Boolean(state.playerOpen);
  const displayStatus =
    !playerOpen && state.status === 'filtering_active'
      ? 'filters_loaded'
      : state.status;

  statusPill.className = pillClass(displayStatus);
  statusPill.textContent = statusLabel(displayStatus, playerOpen);

  const detected = state.detected;
  if (
    !detected ||
    ((!detected.title || detected.title === 'Unknown title') &&
      !detected.gti &&
      !state.selectedGti)
  ) {
    const detail = state.statusDetail || 'Open a movie or show on Prime Video.';
    const detecting =
      /detect/i.test(detail) || (playerOpen && state.status !== 'title_not_matched');
    if (detecting && isStillWaiting(`detect|${detail}|${playerOpen}`)) {
      detectedKind.innerHTML = loaderHtml(
        playerOpen ? 'Detecting what’s playing…' : 'Detecting title…'
      );
    } else {
      detectedKind.textContent = detail;
    }
    detectedTitle.hidden = true;
    detectedMeta.hidden = true;
    episodesCard.hidden = true;
    markCard.hidden = true;
    savedCard.hidden = true;
    return;
  }

  const gti = activeGti(state) || '';
  if (gti && gti !== lastAuthorGti) {
    lastAuthorGti = gti;
    clearPendingMarks();
    setMarkStatus('');
    loadingKey = '';
  }

  const titleLabel =
    !detected.title || detected.title === 'Unknown title'
      ? 'Prime title'
      : detected.title;

  detectedKind.textContent = kindLabel(detected.kind);
  detectedTitle.hidden = false;
  detectedTitle.textContent = titleLabel;

  const metaParts: string[] = [];
  if (detected.seasonLabel) metaParts.push(detected.seasonLabel);
  if (detected.episodeName || state.selectedEpisode) {
    metaParts.push(state.selectedEpisode || detected.episodeName || '');
  }
  if (gti) metaParts.push(gti);
  if (playerOpen) metaParts.push('Playing');
  detectedMeta.hidden = false;
  const metaText = metaParts.filter(Boolean).join(' · ');

  if (!gti && isStillWaiting(`gti|${detected.title}|${playerOpen}`)) {
    detectedMeta.innerHTML =
      (metaText ? `${escapeHtml(metaText)} · ` : '') +
      loaderHtml(
        playerOpen
          ? 'Detecting episode / movie…'
          : detected.kind === 'show'
            ? 'Fetching resume episode ID…'
            : 'Fetching Amazon ID…'
      );
  } else {
    detectedMeta.textContent = metaText;
  }

  // While playing, the current episode is shown above; the list is for picking.
  if (detected.kind === 'show' && !playerOpen) {
    episodesCard.hidden = false;
    const episodes = detected.episodes || [];
    if (episodes.length === 0) {
      const waitingForList = isStillWaiting(`episodes|${detected.title}`);
      episodesDetail.textContent = waitingForList
        ? ''
        : playerOpen
          ? detected.episodeName || detected.gti
            ? 'Current episode from player APIs.'
            : 'Episode list not available yet.'
          : 'Open Episodes or start playback to load the list.';
      episodeList.innerHTML =
        detected.episodeName || detected.gti
          ? `<button type="button" class="candidate active">
             <div class="candidate-title">${escapeHtml(
               detected.episodeName || 'Current episode'
             )}</div>
             <div class="candidate-meta">${escapeHtml(
               detected.gti || 'From player'
             )}</div>
           </button>`
          : waitingForList
            ? `<div class="loader-row"><span class="spinner" aria-hidden="true"></span>Loading episodes…</div>`
            : `<div class="empty">No episodes listed</div>`;
    } else {
      episodesDetail.textContent = `${episodes.length} episode${
        episodes.length === 1 ? '' : 's'
      }`;

      episodeList.innerHTML = '';
      for (const ep of episodes) {
        const btn = document.createElement('button');
        btn.type = 'button';
        const selected =
          (ep.titleId &&
            (state.selectedGti || detected.gti)?.toLowerCase() ===
              ep.titleId.toLowerCase()) ||
          state.selectedEpisode?.toLowerCase() === ep.name.toLowerCase() ||
          detected.episodeName?.toLowerCase() === ep.name.toLowerCase() ||
          Boolean(ep.nowPlaying);
        btn.className = selected ? 'candidate active' : 'candidate';
        btn.innerHTML = `
          <div class="candidate-title">${escapeHtml(ep.name)}</div>
          <div class="candidate-meta">${escapeHtml(
            ep.titleId || ep.label || detected.title
          )}${ep.nowPlaying ? ' · Now playing' : ''}</div>
        `;
        btn.addEventListener('click', () => {
          void chrome.runtime.sendMessage({
            type: 'SCF_SELECT_EPISODE',
            episodeName: ep.name,
            gti: ep.titleId,
          });
        });
        episodeList.appendChild(btn);
      }
    }
  } else {
    episodesCard.hidden = true;
  }

  updateMarkControls(state);
  // Fetches only when the GTI changes (loadingKey); saves refresh explicitly.
  void refreshSavedFilters(state);
}

function applyTimeUpdate(
  playerOpen: boolean,
  currentTime: number | null,
  adPlaying: boolean
): void {
  if (!latestState) return;
  const playerChanged = latestState.playerOpen !== playerOpen;
  latestState = { ...latestState, playerOpen, currentTime, adPlaying };
  if (playerChanged) {
    render(latestState);
  } else {
    updateMarkControls(latestState);
  }
}

async function fetchPlaybackTime(): Promise<number> {
  const response = (await chrome.runtime.sendMessage({
    type: 'SCF_GET_PLAYBACK_TIME',
  })) as { ok?: boolean; currentTime?: number; error?: string } | undefined;

  if (!response?.ok || typeof response.currentTime !== 'number') {
    throw new Error(response?.error || 'Could not read player time');
  }
  return response.currentTime;
}

async function onMarkStart(): Promise<void> {
  try {
    pendingStart = await fetchPlaybackTime();
    inputFrom.value = formatTime(pendingStart);
    inputFrom.classList.remove('invalid');
    setMarkStatus(`From set to ${formatTime(pendingStart)}`);
    if (latestState) updateMarkControls(latestState);
  } catch (err) {
    setMarkStatus(
      err instanceof Error ? err.message : 'Could not read player time',
      'error'
    );
  }
}

async function onMarkEnd(): Promise<void> {
  try {
    pendingEnd = await fetchPlaybackTime();
    inputTo.value = formatTime(pendingEnd);
    inputTo.classList.remove('invalid');
    if (pendingStart != null && pendingEnd <= pendingStart) {
      setMarkStatus('To must be after From', 'error');
    } else {
      setMarkStatus(`To set to ${formatTime(pendingEnd)}`);
    }
    if (latestState) updateMarkControls(latestState);
  } catch (err) {
    setMarkStatus(
      err instanceof Error ? err.message : 'Could not read player time',
      'error'
    );
  }
}

async function onSaveFilter(): Promise<void> {
  const state = latestState;
  if (!state?.detected || pendingStart == null || pendingEnd == null) return;
  if (pendingEnd <= pendingStart) {
    setMarkStatus('To must be greater than From', 'error');
    return;
  }

  const detected = state.detected;
  const episode = activeEpisode(state);
  const gti = activeGti(state);
  if (!gti) {
    setMarkStatus('Wait for Amazon GTI (play/resume first)', 'error');
    return;
  }

  saving = true;
  setMarkStatus('');
  updateMarkControls(state);

  const filter: FilterInterval = {
    id: `filter-${Date.now()}`,
    start: Math.round(pendingStart * 10) / 10,
    end: Math.round(pendingEnd * 10) / 10,
    action: selectedAction(),
    label: markLabelInput.value.trim() || undefined,
  };

  try {
    const config = await appendFiltersForTitle({
      title: detected.title || 'Prime title',
      kind: detected.kind === 'show' ? 'show' : 'movie',
      episodeName: episode || undefined,
      gti,
      videoUrl: detected.pageUrl || `gti://${gti}`,
      filters: [filter],
    });

    clearPendingMarks();
    markLabelInput.value = '';
    loadingKey = '';
    const contextLabel =
      detected.kind === 'show' && episode
        ? `${detected.title} · ${episode}`
        : detected.title;
    renderSavedFilters(config.filters, contextLabel);
    notifyContentFiltersChanged(gti);
    setMarkStatus(
      `Saved ${filter.action} ${formatTime(filter.start)}–${formatTime(filter.end)}`,
      'ok'
    );
  } catch (err) {
    setMarkStatus(err instanceof Error ? err.message : 'Save failed', 'error');
  } finally {
    saving = false;
    if (latestState) updateMarkControls(latestState);
  }
}

inputFrom.addEventListener('input', () => onTimeInput(inputFrom, 'start'));
inputTo.addEventListener('input', () => onTimeInput(inputTo, 'end'));

async function withTimeFetch(
  which: 'start' | 'end',
  action: () => Promise<void>
): Promise<void> {
  if (fetchingTime) return;
  fetchingTime = which;
  if (latestState) updateMarkControls(latestState);
  try {
    await action();
  } finally {
    fetchingTime = null;
    if (latestState) updateMarkControls(latestState);
  }
}

btnMarkStart.addEventListener('click', () => {
  void withTimeFetch('start', onMarkStart);
});
btnMarkEnd.addEventListener('click', () => {
  void withTimeFetch('end', onMarkEnd);
});
btnSaveFilter.addEventListener('click', () => {
  void onSaveFilter();
});

async function loadState(): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    type: 'SCF_GET_STATE',
  })) as { state?: SidePanelState } | undefined;

  if (response?.state) {
    render(response.state);
    return;
  }

  render({
    playerOpen: false,
    sidePanelOpen: true,
    status: 'initialized',
    detected: null,
    selectedEpisode: null,
    currentTime: null,
    updatedAt: Date.now(),
  });
}

function connectPanelPort(): void {
  const port = chrome.runtime.connect({ name: 'scf-sidepanel' });
  port.onMessage.addListener((message) => {
    if (message?.type === 'SCF_STATE' && message.state) {
      render(message.state as SidePanelState);
    }
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'SCF_STATE' && message.state) {
    render(message.state as SidePanelState);
    return;
  }
  if (message?.type === 'SCF_TIME') {
    applyTimeUpdate(
      Boolean(message.playerOpen),
      typeof message.currentTime === 'number' ? message.currentTime : null,
      Boolean(message.adPlaying)
    );
  }
});

connectPanelPort();
void loadState();
