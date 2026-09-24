// ═══════════════════════════════════════
// COMMUN — douchette Bluetooth, pont natif, sélecteur de DLC
// ═══════════════════════════════════════

// ── Douchette : capte les scans où que soit le focus ──
// La douchette se comporte comme un clavier : elle « tape » le code très vite puis Entrée.
// On écoute tout le document, donc plus besoin de garder un champ sélectionné.
// Si l'utilisateur écrit dans un vrai champ (nom de produit, recherche…), on le laisse tranquille.
const ScanCapture = (() => {
  let buffer = '';
  let lastKey = 0;
  let handler = null;
  const MAX_GAP_MS = 150; // au-delà, c'est un humain qui tape : on repart de zéro

  function isEditable(el) {
    if (!el || el === document.body) return false;
    if (el.dataset && el.dataset.scan !== undefined) return false; // champ dédié au scan
    return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
  }

  document.addEventListener('keydown', (e) => {
    if (!handler || isEditable(document.activeElement)) return;
    const now = Date.now();
    if (now - lastKey > MAX_GAP_MS) buffer = '';
    lastKey = now;
    if (e.key === 'Enter') {
      const code = buffer.trim();
      buffer = '';
      if (code.length >= 3) { e.preventDefault(); handler(code); }
      return;
    }
    if (e.key.length === 1) { buffer += e.key; e.preventDefault(); }
  }, true);

  return { start(fn) { handler = fn; }, stop() { handler = null; }, current() { return handler; } };
})();

// ── Pont natif (plugin ScannerNative) ──
const Native = (() => {
  const plugin = Store.native;
  return {
    available: !!plugin,
    plugin,
    async status() { return plugin ? plugin.getStatus() : null; },
    onScannerConnected(cb) { if (plugin) plugin.addListener('scannerConnected', cb); },
    onScannerDisconnected(cb) { if (plugin) plugin.addListener('scannerDisconnected', cb); },
    onResume(cb) { if (plugin) plugin.addListener('appResumed', cb); },
  };
})();

// Pastille « douchette » dans l'en-tête (élément #scanner-pill, facultatif)
async function refreshScannerPill() {
  const pill = document.getElementById('scanner-pill');
  if (!pill) return;
  const s = await Native.status().catch(() => null);
  let state = 'off', text = '📡 Douchette ?';
  if (s && !s.targetAddress) { state = 'warn'; text = '📡 Choisir la douchette'; }
  else if (s && s.scannerConnected) { state = 'on'; text = '📡 Douchette connectée'; }
  else if (s) { state = 'off'; text = '📡 Douchette déconnectée'; }
  pill.className = `scanner-pill ${state}`;
  pill.textContent = text;
}
Native.onScannerConnected(refreshScannerPill);
Native.onScannerDisconnected(refreshScannerPill);
Native.onResume(refreshScannerPill);
window.addEventListener('load', refreshScannerPill);

// ── Sélecteur de DLC : boutons rapides + calendrier ──
// Renvoie une promesse : 'AAAA-MM-JJ' ou null si annulé.
function pickDlc(title = 'Choisir la DLC', subtitle = '') {
  return new Promise((resolve) => {
    const quick = [3, 5, 7, 10, 14, 21];
    const today = new Date();
    const fmt = d => d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' });
    const overlay = document.createElement('div');
    overlay.className = 'dlc-picker-overlay';
    overlay.innerHTML = `
      <div class="dlc-picker">
        <div class="dlc-picker-title">📅 ${title}</div>
        ${subtitle ? `<div class="dlc-picker-sub">${subtitle}</div>` : ''}
        <div class="dlc-picker-grid">
          ${quick.map(n => {
            const d = new Date(today); d.setDate(d.getDate() + n);
            return `<button class="dlc-quick" data-date="${localDateStr(d)}"><strong>J+${n}</strong><span>${fmt(d)}</span></button>`;
          }).join('')}
        </div>
        <div class="dlc-picker-row">
          <input type="date" class="dlc-date-input" min="${localDateStr(today)}">
          <button class="dlc-ok">OK</button>
        </div>
        <button class="dlc-cancel">Annuler</button>
      </div>`;
    // Pendant le choix, un scan éventuel ne doit rien déclencher
    const savedHandler = ScanCapture.current();
    ScanCapture.stop();
    const close = (val) => { ScanCapture.start(savedHandler); overlay.remove(); resolve(val); };
    overlay.addEventListener('click', (e) => {
      const q = e.target.closest('.dlc-quick');
      if (q) return close(q.dataset.date);
      if (e.target.closest('.dlc-ok')) {
        const v = overlay.querySelector('.dlc-date-input').value;
        if (v) close(v);
        return;
      }
      if (e.target.closest('.dlc-cancel') || e.target === overlay) close(null);
    });
    document.body.appendChild(overlay);
  });
}

function formatDlcDisplay(dlcStr) {
  if (!dlcStr) return '—';
  const d = new Date(dlcStr + 'T00:00:00');
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Échappe le texte injecté dans du HTML (noms de produits saisis à la main)
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
