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
const markHint = document.getElementById('mark-hint') as HTMLParagraphElement;
const markClock = document.getElementById('mark-clock') as HTMLParagraphElement;
const markStartLabel = document.getElementById('mark-start-label') as HTMLSpanElement;
const markEndLabel = document.getElementById('mark-end-label') as HTMLSpanElement;
const btnMarkStart = document.getElementById('btn-mark-start') as HTMLButtonElement;
const btnMarkEnd = document.getElementById('btn-mark-end') as HTMLButtonElement;
const btnSaveFilter = document.getElementById('btn-save-filter') as HTMLButtonElement;
const markLabelInput = document.getElementById('mark-label') as HTMLInputElement;
const markStatus = document.getElementById('mark-status') as HTMLParagraphElement;
const savedCard = document.getElementById('saved-card') as HTMLElement;
const savedList = document.getElementById('saved-list') as HTMLUListElement;

let latestState: SidePanelState | null = null;
let pendingStart: number | null = null;
let pendingEnd: number | null = null;
let savedFilters: FilterInterval[] = [];
let loadingKey = '';
let saving = false;

function pillClass(status: ExtensionStatus): string {
  if (status === 'filtering_active' || status === 'filters_loaded' || status === 'video_detected') {
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
      return 'Detected';
    case 'filtering_active':
      return 'Playing';
    case 'awaiting_selection':
      return 'Pick episode';
    case 'title_not_matched':
      return 'No title';
    case 'backend_failed':
      return 'Error';
    default:
      return 'Waiting';
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
  // Filters are keyed by Amazon GTI only
  return Boolean(activeGti(state));
}

function setMarkStatus(message: string, kind: 'ok' | 'error' | 'muted' = 'muted'): void {
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

  markCard.hidden = !authorable;
  if (!authorable) return;

  markClock.textContent = playerOpen && t != null ? formatTime(t) : '--:--';
  markHint.textContent = playerOpen
    ? 'Mark start, play through the section, then mark end and save.'
    : 'Open the player first, then mark start and end timestamps.';

  btnMarkStart.disabled = !playerOpen || saving;
  btnMarkEnd.disabled = !playerOpen || pendingStart == null || saving;

  markStartLabel.textContent =
    pendingStart == null ? 'Start: —' : `Start: ${formatTime(pendingStart)}`;
  markEndLabel.textContent =
    pendingEnd == null ? 'End: —' : `End: ${formatTime(pendingEnd)}`;

  const ready =
    pendingStart != null &&
    pendingEnd != null &&
    pendingEnd > pendingStart &&
    !saving;
  btnSaveFilter.disabled = !ready;
}

function renderSavedFilters(filters: FilterInterval[]): void {
  savedFilters = filters;
  if (filters.length === 0) {
    savedCard.hidden = true;
    savedList.innerHTML = '';
    return;
  }

  savedCard.hidden = false;
  savedList.innerHTML = filters
    .map(
      (f) => `
      <li>
        <span>${escapeHtml(f.label || f.id)} · ${formatTime(f.start)}–${formatTime(f.end)}</span>
        <span class="action">${escapeHtml(f.action)}</span>
      </li>`
    )
    .join('');
}

async function refreshSavedFilters(state: SidePanelState): Promise<void> {
  const detected = state.detected;
  const gti = activeGti(state);
  if ((!detected?.title || detected.title === 'Unknown title') && !gti) {
    loadingKey = '';
    renderSavedFilters([]);
    return;
  }

  if (!gti) {
    loadingKey = '';
    renderSavedFilters([]);
    return;
  }

  const stableKey = `gti|${gti}`;
  if (stableKey === loadingKey) return;
  loadingKey = stableKey;

  try {
    const config = await tryResolveFiltersByQuery(gti);
    if (loadingKey !== stableKey) return;
    renderSavedFilters(config?.filters ?? []);
  } catch {
    if (loadingKey !== stableKey) return;
    renderSavedFilters([]);
  }
}

function render(state: SidePanelState): void {
  latestState = state;
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
    detectedKind.textContent =
      state.statusDetail || 'Open a movie or show on Prime Video.';
    detectedTitle.hidden = true;
    detectedMeta.hidden = true;
    episodesCard.hidden = true;
    markCard.hidden = true;
    savedCard.hidden = true;
    return;
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
  const gti = state.selectedGti || detected.gti;
  if (gti) metaParts.push(gti);
  if (playerOpen) metaParts.push('Player open');
  detectedMeta.hidden = false;
  detectedMeta.textContent = metaParts.filter(Boolean).join(' · ') || '';

  if (detected.kind === 'show') {
    episodesCard.hidden = false;
    const episodes = detected.episodes || [];
    if (episodes.length === 0) {
      episodesDetail.textContent = playerOpen
        ? detected.episodeName || detected.gti
          ? 'Current episode detected from player APIs. Full list not loaded yet.'
          : 'No episode list found yet — start playback so Prime loads episodeList.'
        : 'No episode list found yet — open Episodes or start playback on Prime.';
      episodeList.innerHTML = detected.episodeName || detected.gti
        ? `<button type="button" class="candidate active">
             <div class="candidate-title">${escapeHtml(
               detected.episodeName || 'Current episode'
             )}</div>
             <div class="candidate-meta">${escapeHtml(
               detected.gti || 'From player'
             )}</div>
           </button>`
        : `<div class="empty">No episodes listed</div>`;
    } else {
      episodesDetail.textContent = `${episodes.length} episode${
        episodes.length === 1 ? '' : 's'
      } from Prime catalog`;

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
  void refreshSavedFilters(state);
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
    pendingEnd = null;
    setMarkStatus(`Start marked at ${formatTime(pendingStart)}`);
    if (latestState) updateMarkControls(latestState);
  } catch (err) {
    setMarkStatus(err instanceof Error ? err.message : 'Mark start failed', 'error');
  }
}

async function onMarkEnd(): Promise<void> {
  try {
    const t = await fetchPlaybackTime();
    if (pendingStart == null) {
      setMarkStatus('Mark start first', 'error');
      return;
    }
    if (t <= pendingStart) {
      setMarkStatus('End must be after start — keep playing, then mark end', 'error');
      return;
    }
    pendingEnd = t;
    setMarkStatus(`Range ${formatTime(pendingStart)} → ${formatTime(pendingEnd)}`);
    if (latestState) updateMarkControls(latestState);
  } catch (err) {
    setMarkStatus(err instanceof Error ? err.message : 'Mark end failed', 'error');
  }
}

async function onSaveFilter(): Promise<void> {
  const state = latestState;
  if (!state?.detected || pendingStart == null || pendingEnd == null) return;
  if (pendingEnd <= pendingStart) {
    setMarkStatus('End must be greater than start', 'error');
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
  btnSaveFilter.disabled = true;
  setMarkStatus('Saving…');

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

    pendingStart = null;
    pendingEnd = null;
    markLabelInput.value = '';
    loadingKey = '';
    renderSavedFilters(config.filters);
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

btnMarkStart.addEventListener('click', () => {
  void onMarkStart();
});
btnMarkEnd.addEventListener('click', () => {
  void onMarkEnd();
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
  }
});

connectPanelPort();
void loadState();
