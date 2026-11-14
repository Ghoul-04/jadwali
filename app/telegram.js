// app/telegram.js — thin, version-guarded wrapper around Telegram.WebApp.
// Everything degrades to a no-op (or a browser equivalent) outside Telegram.

const W = typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined;

/** True when launched inside Telegram (menu button gives initData; keyboard button may not). */
export const inTelegram = !!(W && (W.initData || (W.platform && W.platform !== 'unknown')));

/** sendData only works when the app was opened from the bot's keyboard button (no query_id). */
export const canSendData = inTelegram && !W.initDataUnsafe?.query_id && typeof W.sendData === 'function';

export function atLeast(v) {
  try { return !!(W && W.isVersionAtLeast && W.isVersionAtLeast(v)); } catch { return false; }
}

export const tg = {
  raw: W,
  user: inTelegram ? W.initDataUnsafe?.user || null : null,
  platform: W?.platform || 'web',
  colorScheme() { return inTelegram ? W.colorScheme : null; },

  init() {
    if (!W) return;
    try { W.ready(); } catch {}
    if (!inTelegram) return;
    try { W.expand(); } catch {}
    if (atLeast('7.7')) { try { W.disableVerticalSwipes(); } catch {} }
  },

  setColors(header, bg, bottom) {
    if (!inTelegram || !atLeast('6.1')) return;
    try { W.setHeaderColor(header); } catch {}
    try { W.setBackgroundColor(bg); } catch {}
    if (bottom && atLeast('7.10')) { try { W.setBottomBarColor(bottom); } catch {} }
  },

  on(event, fn) {
    if (!inTelegram) return;
    try { W.onEvent(event, fn); } catch {}
  },

  /** Safe-area insets (Bot API 8.0+). Returns {top,bottom,left,right} in px. */
  insets() {
    const z = { top: 0, bottom: 0, left: 0, right: 0 };
    if (!inTelegram || !atLeast('8.0')) return { safe: z, content: z };
    return { safe: { ...z, ...(W.safeAreaInset || {}) }, content: { ...z, ...(W.contentSafeAreaInset || {}) } };
  },

  haptic(type = 'light') {
    if (!inTelegram || !atLeast('6.1')) return;
    const H = W.HapticFeedback;
    try {
      if (type === 'select') H.selectionChanged();
      else if (type === 'success' || type === 'warning' || type === 'error') H.notificationOccurred(type);
      else H.impactOccurred(type);
    } catch {}
  },

  back: {
    _fn: null,
    show(fn) {
      this._fn && this.hide();
      this._fn = fn;
      if (inTelegram && atLeast('6.1')) {
        try { W.BackButton.onClick(fn); W.BackButton.show(); } catch {}
      }
    },
    hide() {
      if (inTelegram && atLeast('6.1') && this._fn) {
        try { W.BackButton.offClick(this._fn); W.BackButton.hide(); } catch {}
      }
      this._fn = null;
    },
  },

  openLink(url) {
    if (inTelegram && url.startsWith('https://t.me/')) {
      try { W.openTelegramLink(url); return; } catch {}
    }
    window.open(url, '_blank', 'noopener');
  },

  sendData(str) { if (canSendData) W.sendData(str); },

  hasCloud() { return inTelegram && atLeast('6.9') && !!W.CloudStorage; },
  cloud: W?.CloudStorage,
};
