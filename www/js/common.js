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
// opts.allowPast : correction d'une DLC déjà saisie (dates passées permises) ; opts.value : date actuelle
function pickDlc(title = 'Choisir la DLC', subtitle = '', opts = {}) {
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
          <input type="date" class="dlc-date-input" ${opts.allowPast ? '' : `min="${localDateStr(today)}"`} value="${opts.value || ''}">
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

// ── Import JSON copié-collé (comme le bouton « 📥 Importer » de la version web) ──
// Le JSON collé est FUSIONNÉ avec les données de la tablette : rien n'est écrasé.
const JSON_TARGETS = {
  'chambre-froide.json': 'chambre-froide.json (lots de la chambre froide)',
  'produits.json': 'produits.json (dictionnaire codes)',
  'congelateur.json': 'congelateur.json',
  'cf-mapping.json': 'cf-mapping.json (liaisons de codes)',
};

// Renvoie { merged, added } sans rien écrire ; lève une erreur si le JSON n'a pas la bonne forme
// dateEntree : date appliquée à tous les NOUVEAUX lots / produits (celle du JSON est ignorée)
function mergeJsonImport(target, current, parsed, dateEntree = localDateStr(new Date())) {
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  if (target === 'produits.json' || target === 'cf-mapping.json') {
    if (!isObj(parsed)) throw new Error('Il faut un objet { "code": … }');
    const cur = current || {};
    const added = Object.keys(parsed).filter(k => !(k in cur)).length;
    return { merged: { ...cur, ...parsed }, added };
  }
  const list = Array.isArray(parsed) ? parsed : isObj(parsed) ? [parsed] : null;
  if (!list || !list.every(isObj)) throw new Error('Il faut une liste [ { … }, … ]');
  const merged = [...(current || [])];
  let added = 0;

  if (target === 'congelateur.json') {
    // Dédoublonne par (nom, date)
    const seen = new Set(merged.map(i => `${i.nom}::${i.date}`));
    for (const raw of list) {
      const item = { code: '', ...raw, date: dateEntree };
      const key = `${item.nom}::${item.date}`;
      if (!seen.has(key)) { merged.push(item); seen.add(key); added++; }
    }
    return { merged, added };
  }

  // chambre-froide.json : même lot (code facture + DLC) → on ajoute la quantité, sinon nouveau lot.
  // Un lot déjà présent (même id) n'est pas compté deux fois si on recolle le même JSON.
  for (const raw of list) {
    const qty = Math.max(1, parseInt(raw.qty) || 1);
    if (raw.id && merged.some(s => s.id === raw.id)) continue;
    const existing = raw.codeFacture && merged.find(s => s.codeFacture === raw.codeFacture && s.dlc === (raw.dlc || null));
    if (existing) { existing.qty = (existing.qty || 0) + qty; continue; }
    merged.push({
      codeFacture: null, codePhysique: null, supplier: '',
      ...raw,
      id: raw.id || 'cf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      nom: raw.nom || raw.codeFacture || 'Sans nom',
      dlc: raw.dlc || null,
      qty,
      dateEntree,
    });
    added++;
  }
  return { merged, added };
}

function openJsonImport(defaultTarget = 'chambre-froide.json') {
  const overlay = document.createElement('div');
  overlay.className = 'json-import-overlay';
  overlay.innerHTML = `
    <div class="json-import">
      <div class="dlc-picker-title">📥 Importer un JSON</div>
      <div class="dlc-picker-sub">Colle le JSON à ajouter — il sera <strong>fusionné</strong> avec les données de la tablette, rien n'est écrasé.</div>
      <select class="json-import-target">
        ${Object.entries(JSON_TARGETS).map(([v, l]) => `<option value="${v}" ${v === defaultTarget ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <label class="json-import-date-row">📥 Date d'entrée des nouveaux articles
        <input type="date" class="json-import-date" value="${localDateStr(new Date())}" max="${localDateStr(new Date())}">
      </label>
      <textarea class="json-import-text" placeholder="Colle le JSON ici…"></textarea>
      <div class="json-import-error"></div>
      <div class="dlc-picker-row">
        <button class="dlc-ok json-import-ok" style="flex:1;">✓ Importer</button>
        <button class="dlc-cancel json-import-cancel">Annuler</button>
      </div>
    </div>`;
  const close = () => overlay.remove();
  const fail = msg => { overlay.querySelector('.json-import-error').textContent = msg; };
  overlay.addEventListener('click', async (e) => {
    if (e.target.closest('.json-import-cancel') || e.target === overlay) return close();
    if (!e.target.closest('.json-import-ok')) return;
    const target = overlay.querySelector('.json-import-target').value;
    const raw = overlay.querySelector('.json-import-text').value.trim();
    const dateEntree = overlay.querySelector('.json-import-date').value;
    if (!raw) return fail('Colle du JSON');
    if (!dateEntree && (target === 'chambre-froide.json' || target === 'congelateur.json')) return fail("Choisis la date d'entrée");
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return fail('JSON invalide — vérifie la syntaxe'); }
    let result;
    try { result = mergeJsonImport(target, await Store.load(target), parsed, dateEntree); } catch (err) { return fail(err.message); }
    await Store.save(target, result.merged);
    close();
    showToast(`${target} fusionné — ${result.added} ajout${result.added > 1 ? 's' : ''} ✓`, 'success');
    // Chaque page garde ses données en mémoire : on recharge pour repartir de la version fusionnée
    setTimeout(() => location.reload(), 900);
  });
  document.body.appendChild(overlay);
}

// ── Choix d'une date passée (date d'entrée) ── renvoie 'AAAA-MM-JJ' ou null
function pickPastDate(title, subtitle = '', value = '') {
  return new Promise((resolve) => {
    const today = localDateStr(new Date());
    const overlay = document.createElement('div');
    overlay.className = 'dlc-picker-overlay';
    overlay.innerHTML = `
      <div class="dlc-picker">
        <div class="dlc-picker-title">📥 ${title}</div>
        ${subtitle ? `<div class="dlc-picker-sub">${subtitle}</div>` : ''}
        <div class="dlc-picker-row">
          <input type="date" class="dlc-date-input" max="${today}" value="${value || today}">
          <button class="dlc-ok">OK</button>
        </div>
        <button class="dlc-cancel">Annuler</button>
      </div>`;
    const savedHandler = ScanCapture.current();
    ScanCapture.stop();
    const close = (val) => { ScanCapture.start(savedHandler); overlay.remove(); resolve(val); };
    overlay.addEventListener('click', (e) => {
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
