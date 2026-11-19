import type { ExtensionStatus } from '../types';

const ROOT_ID = 'scf-poc-status-indicator';

const STATUS_COPY: Record<ExtensionStatus, string> = {
  initialized: 'Extension initialized',
  video_detected: 'Video detected',
  filters_loaded: 'Filters loaded',
  filtering_active: 'Filtering active',
  backend_failed: 'Backend connection failed',
  title_not_matched: 'Title not matched',
  idle: 'Idle',
};

const STATUS_COLOR: Record<ExtensionStatus, string> = {
  initialized: '#5a6b7a',
  video_detected: '#2563eb',
  filters_loaded: '#0f766e',
  filtering_active: '#1a7a5c',
  backend_failed: '#be123c',
  title_not_matched: '#b45309',
  idle: '#5a6b7a',
};

export class StatusIndicator {
  private root: HTMLDivElement | null = null;

  mount(): void {
    if (document.getElementById(ROOT_ID)) {
      this.root = document.getElementById(ROOT_ID) as HTMLDivElement;
      return;
    }

    const el = document.createElement('div');
    el.id = ROOT_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    Object.assign(el.style, {
      position: 'fixed',
      top: '12px',
      right: '12px',
      zIndex: '2147483646',
      maxWidth: '260px',
      padding: '8px 12px',
      borderRadius: '8px',
      background: 'rgba(20, 28, 36, 0.92)',
      color: '#f4f6f8',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '12px',
      lineHeight: '1.35',
      boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
      pointerEvents: 'none',
      transition: 'opacity 160ms ease',
    });

    document.documentElement.appendChild(el);
    this.root = el;
    this.setStatus('initialized');
  }

  setStatus(status: ExtensionStatus, detail?: string): void {
    if (!this.root) this.mount();
    if (!this.root) return;

    const label = STATUS_COPY[status];
    const color = STATUS_COLOR[status];
    this.root.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="width:8px;height:8px;border-radius:999px;background:${color};flex-shrink:0;"></span>
        <div>
          <div style="font-weight:600;">SCF · ${label}</div>
          ${detail ? `<div style="opacity:0.8;margin-top:2px;">${escapeHtml(detail)}</div>` : ''}
        </div>
      </div>
    `;
  }

  destroy(): void {
    this.root?.remove();
    this.root = null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
