import type { ExtensionStatus } from '../types';

const ROOT_ID = 'scf-status-dot';

/**
 * Tiny floating indicator shown while the side panel is closed.
 * Click opens the SCF side panel.
 */
export class StatusDot {
  private root: HTMLButtonElement | null = null;
  private visible = false;

  mount(onOpenPanel: () => void): void {
    if (document.getElementById(ROOT_ID)) {
      this.root = document.getElementById(ROOT_ID) as HTMLButtonElement;
      return;
    }

    const btn = document.createElement('button');
    btn.id = ROOT_ID;
    btn.type = 'button';
    btn.title = 'Open SCF side panel';
    btn.setAttribute('aria-label', 'Open SCF side panel');
    Object.assign(btn.style, {
      position: 'fixed',
      right: '18px',
      bottom: '96px',
      zIndex: '2147483647',
      width: '21px',
      height: '21px',
      padding: '0',
      border: '2px solid rgba(255,255,255,0.92)',
      borderRadius: '999px',
      background: '#5a6b7a',
      boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
      cursor: 'pointer',
      display: 'none',
      pointerEvents: 'auto',
    } as CSSStyleDeclaration);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onOpenPanel();
    });

    document.documentElement.appendChild(btn);
    this.root = btn;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!this.root) return;
    this.root.style.display = visible ? 'block' : 'none';
  }

  setStatus(status: ExtensionStatus, filteringActive: boolean): void {
    if (!this.root) return;

    let color = '#5a6b7a';
    let title = 'SCF · idle — click to open';

    if (status === 'backend_failed') {
      color = '#be123c';
      title = 'SCF · backend issue — click to open';
    } else if (filteringActive || status === 'filtering_active') {
      color = '#1a7a5c';
      title = 'SCF · filtering active — click to open';
    } else if (status === 'awaiting_selection') {
      color = '#ca8a04';
      title = 'SCF · choose a title — click to open';
    } else if (status === 'video_detected' || status === 'title_not_matched') {
      color = '#2563eb';
      title = 'SCF · player detected — click to open';
    }

    this.root.style.background = color;
    this.root.title = title;
    this.root.setAttribute('aria-label', title);

    // Soft pulse while filtering
    this.root.style.boxShadow =
      filteringActive || status === 'filtering_active'
        ? '0 0 0 4px rgba(26,122,92,0.28), 0 4px 14px rgba(0,0,0,0.35)'
        : '0 4px 14px rgba(0,0,0,0.35)';
  }

  destroy(): void {
    this.root?.remove();
    this.root = null;
  }
}
