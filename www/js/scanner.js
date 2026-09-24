// ═══════════════════════════════════════
// SCANNER BOUCHERIE — page principale
// ═══════════════════════════════════════
// Toutes les données sont sur la tablette (voir store.js). Plus de connexion Google.

// ── STATE ──
let produitsDict = {};      // { code: nom }
let cfStock = null;         // lots de la chambre froide
let cfMappingCache = null;  // code physique <-> code facture
let freezerItems = [];
let selectedLabels = new Set();
let allEntries = [];        // cache pour la recherche dans l'historique

let mode = 'sortie';        // 'sortie' | 'viande' | 'dlc' | 'partiel'
let meatModeDlc = null;     // DLC de la bête en cours (mode viande)
let currentScan = null;     // scan affiché : { code, nom, date, entryId }
let pendingUndo = null;     // { date, entryId, cfRestore } — annulation possible quelques secondes
let undoTimer = null;
const UNDO_MS = 8000;

// Les scans sont traités un par un, dans l'ordre (rafale de la douchette)
let scanQueue = Promise.resolve();
function queueScan(code) {
  scanQueue = scanQueue.then(() => handleScan(code)).catch(e => {
    console.error(e);
    showToast('Erreur pendant le scan', 'error');
  });
}

// Valeur utilisable dans un attribut onclick="fn(...)"
const jsArg = v => esc(JSON.stringify(v));

// ═══════════════════════════════════════
// DONNÉES
// ═══════════════════════════════════════
async function saveProduitsJson() { await Store.save('produits.json', produitsDict); }

async function loadCfStock() {
  if (cfStock) return cfStock;
  cfStock = (await Store.load('chambre-froide.json')) || [];
  return cfStock;
}
async function saveCfStock() { if (cfStock) await Store.save('chambre-froide.json', cfStock); renderDlcBanner(); }

async function loadCfMapping() {
  if (cfMappingCache) return cfMappingCache;
  cfMappingCache = (await Store.load('cf-mapping.json')) || {};
  return cfMappingCache;
}
async function saveCfMapping(mapping) { cfMappingCache = mapping; await Store.save('cf-mapping.json', mapping); }

function newCfId() { return 'cf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6); }

// ═══════════════════════════════════════
// AIGUILLAGE DES SCANS
// ═══════════════════════════════════════
function onBarcode(code) {
  const tab = document.querySelector('.tab.active')?.dataset.tab;
  if (cfAddOpen()) { cfAddScan(code); return; }
  if (tab === 'freezer') { queueFreezerScan(code); return; }
  if (tab !== 'scan') switchTab('scan');
  queueScan(code);
}

async function handleScan(code) {
  finalizeUndo();
  flashReady();
  if (mode === 'viande') return handleMeatScan(code);
  if (mode === 'dlc') return handleDlcModeScan(code);
  return handleExitScan(code);
}

function flashReady() {
  const z = document.getElementById('ready-zone');
  z.classList.add('flash');
  setTimeout(() => z.classList.remove('flash'), 400);
  if (navigator.vibrate) navigator.vibrate(80);
}

function showResult(code, cls, html) {
  document.getElementById('result-code').textContent = code;
  document.getElementById('result-card').className = `result-card visible ${cls}`;
  document.getElementById('result-area').innerHTML = html;
}

function hideResult() {
  document.getElementById('result-card').className = 'result-card';
  currentScan = null;
}

const badge = (color, bg, text) =>
  `<div style="margin-top:8px;padding:10px 12px;background:${bg};border:1px solid ${color};border-radius:8px;font-size:14px;color:${color};">${text}</div>`;
const BADGE_BLUE = ['#7dd3fc', 'rgba(37,99,235,.15)'];
const BADGE_GREEN = ['var(--green)', 'rgba(34,197,94,.15)'];
const BADGE_YELLOW = ['#fbbf24', 'rgba(245,158,11,.15)'];
const BADGE_RED = ['#ff6b6b', 'rgba(230,57,70,.15)'];

// ═══════════════════════════════════════
// MODES
// ═══════════════════════════════════════
async function setMode(next) {
  if (next === 'viande') {
    const dlc = await pickDlc('DLC de la bête', 'Toutes les poches scannées auront cette DLC');
    if (!dlc) return; // annulé : on reste dans le mode actuel
    meatModeDlc = dlc;
  } else {
    meatModeDlc = null;
  }
  mode = next;
  finalizeUndo();
  hideResult();
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  renderModeContext();
}

function renderModeContext() {
  const el = document.getElementById('mode-context');
  const ready = document.getElementById('ready-text');
  if (mode === 'viande') {
    el.innerHTML = `<span>🥩 DLC de la bête : <strong>${formatDlcDisplay(meatModeDlc)}</strong></span>
      <button onclick="changeMeatDlc()">🔄 Nouvelle bête</button>`;
    ready.textContent = 'Scanne les poches en chaîne';
  } else if (mode === 'dlc') {
    el.innerHTML = `<span>📅 Chaque scan te demande sa DLC, puis range le produit en chambre froide.</span>`;
    ready.textContent = 'Scanne un produit à ranger';
  } else if (mode === 'partiel') {
    el.innerHTML = `<span>🍽️ Note l'ouverture sans retirer le produit du stock.</span>
      <button onclick="openCfPicker('ouverture')">📋 Choisir sans scanner</button>`;
    ready.textContent = 'Scanne le produit entamé';
  } else {
    el.innerHTML = '';
    ready.textContent = 'Prêt — scanne un produit';
  }
}

async function changeMeatDlc() {
  const dlc = await pickDlc('Nouvelle bête', 'Choisis la DLC des prochaines poches');
  if (!dlc) return;
  meatModeDlc = dlc;
  renderModeContext();
  showToast('DLC mise à jour ✓', 'success');
}

// ═══════════════════════════════════════
// SORTIE / OUVERTURE — enregistrement automatique
// ═══════════════════════════════════════
async function checkCfMatch(code) {
  const [stock, mapping] = await Promise.all([loadCfStock(), loadCfMapping()]);
  const codeFacture = mapping[code] || code;
  // Plusieurs lots : on prend la DLC la plus proche (premier entré, premier sorti)
  const candidats = stock
    .filter(s => s.codePhysique === code || s.codeFacture === code || s.codeFacture === codeFacture)
    .sort((a, b) => (a.dlc || '9999-12-31').localeCompare(b.dlc || '9999-12-31'));
  return candidats[0] || null;
}

// Retire n du lot ; renvoie de quoi annuler
async function deductFromCf(item, n = 1) {
  const snapshot = { ...item };
  item.qty -= n;
  const removed = item.qty <= 0;
  if (removed) cfStock = cfStock.filter(s => s.id !== item.id);
  await saveCfStock();
  return { id: item.id, removed, snapshot };
}

async function restoreCf(restore) {
  if (!restore) return;
  const stock = await loadCfStock();
  if (restore.removed) stock.push(restore.snapshot);
  else { const it = stock.find(s => s.id === restore.id); if (it) it.qty += restore.snapshot.qty - it.qty; }
  await saveCfStock();
}

async function handleExitScan(code) {
  const partial = mode === 'partiel';
  const cfItem = await checkCfMatch(code);
  const nom = cfItem ? cfItem.nom : produitsDict[code];

  if (!nom) { showUnknownForExit(code); return; }

  await recordExit(code, nom, cfItem, partial);
}

// Enregistre la sortie (ou l'ouverture, la perte, la congélation) : stock + historique, avec annulation possible
// kind : 'sortie' | 'perte' | 'congelation' ; qty : nombre de pièces retirées du lot
async function recordExit(code, nom, cfItem, partial, { kind = 'sortie', qty = 1 } = {}) {
  if (cfItem && !partial) qty = Math.max(1, Math.min(qty, cfItem.qty));
  let cfRestore = null;
  if (cfItem && !partial) cfRestore = await deductFromCf(cfItem, qty);
  if (code && !produitsDict[code]) { produitsDict[code] = nom; saveProduitsJson(); }

  let freezerIds = null;
  if (kind === 'congelation') freezerIds = await addToFreezer(nom, code, qty);

  const action = partial ? 'ouverture' : kind;
  const entry = await Store.addHistoryEntry({ code, nom, action, qty: partial ? 1 : qty });
  currentScan = { code, nom, date: entry.date, entryId: entry.id };

  let info = '📋 Noté dans l\'historique';
  // « Sorti » pour 1 pièce, « 3 sortis » pour plusieurs
  const verb = w => qty > 1 ? `${qty} ${w}s` : w[0].toUpperCase() + w.slice(1);
  const left = () => cfRestore.removed ? 0 : cfItem.qty;
  if (cfItem && partial) info = `🍽️ Ouverture notée — reste en chambre froide`;
  else if (cfItem && kind === 'perte') info = `🗑️ ${verb('jeté')} (perte) — reste ${left()}`;
  else if (cfItem && kind === 'congelation') info = `❄️ ${verb('passé')} au congélateur — reste ${left()}`;
  else if (cfItem) info = `🧊 ${verb('sorti')} de la chambre froide — reste ${left()}`;
  const [c, bg] = cfItem && partial ? BADGE_YELLOW : kind === 'perte' ? BADGE_RED : BADGE_BLUE;

  showResult(code, 'known', `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
      <div class="result-name" id="scan-result-name">${esc(nom)}</div>
      <button class="btn-edit" onclick="editScanName()">✏️ Modifier</button>
    </div>
    <div id="scan-edit-area"></div>
    ${badge(c, bg, info)}
    ${undoRowHtml()}`);
  startUndo({ date: entry.date, entryId: entry.id, cfRestore, freezerIds });
  renderRecent();
}

// Produit inconnu : on demande juste son nom (ou on le relie à un article de la chambre froide)
async function showUnknownForExit(code) {
  currentScan = { code, nom: null };
  showResult(code, 'unknown', `
    <div class="result-name unknown-label">Produit inconnu — donne-lui un nom :</div>
    <input class="name-input" id="name-input" type="text" placeholder="Ex : Gratin Dauphinois"
           onkeydown="if(event.key==='Enter') confirmUnknownExit(${jsArg(code)})">
    <button class="btn-save" style="margin-top:10px;" onclick="confirmUnknownExit(${jsArg(code)})">✓ Enregistrer</button>
    <div id="cf-link-area"></div>`);
  setTimeout(() => document.getElementById('name-input')?.focus(), 100);

  // Articles de la chambre froide encore sans code-barres : un appui suffit pour les relier
  const [stock, mapping] = await Promise.all([loadCfStock(), loadCfMapping()]);
  const sansCode = stock.filter(item => !item.codePhysique && !mapping[item.codeFacture]);
  const area = document.getElementById('cf-link-area');
  if (!area || !sansCode.length) return;
  area.innerHTML = `
    <div style="margin-top:12px;padding:10px 12px;background:rgba(37,99,235,.08);border:1px solid var(--border);border-radius:8px;">
      <div style="font-size:13px;color:var(--text-dim);margin-bottom:8px;">🧊 Ou c'est un de ces articles de la chambre froide ? Appuie dessus :</div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${sansCode.map(item => `<button class="btn-edit" style="text-align:left;padding:10px 12px;font-size:14px;"
            onclick="linkAndExit(${jsArg(code)}, ${jsArg(item.id)})">${esc(item.nom)} <span style="color:var(--text-dim);font-size:12px;">· DLC ${formatDlcDisplay(item.dlc)}</span></button>`).join('')}
      </div>
    </div>`;
}

async function confirmUnknownExit(code) {
  const nom = document.getElementById('name-input')?.value.trim();
  if (!nom) { showToast('Entre un nom', 'error'); return; }
  produitsDict[code] = nom;
  await saveProduitsJson();
  await recordExit(code, nom, null, mode === 'partiel');
}

// Relie le code scanné à un article de la chambre froide, puis enregistre la sortie
async function linkAndExit(code, itemId) {
  const [stock, mapping] = await Promise.all([loadCfStock(), loadCfMapping()]);
  const item = stock.find(s => s.id === itemId);
  if (!item) return;
  if (item.codeFacture) {
    mapping[code] = item.codeFacture;
    mapping[item.codeFacture] = code;
  }
  item.codePhysique = code;
  await Promise.all([saveCfMapping(mapping), saveCfStock()]);
  if (!produitsDict[code]) { produitsDict[code] = item.nom; await saveProduitsJson(); }
  showToast(`Lié à « ${item.nom} » ✓`, 'success');
  await recordExit(code, item.nom, item, mode === 'partiel');
}

function editScanName() {
  const area = document.getElementById('scan-edit-area');
  area.innerHTML = `
    <div class="edit-inline">
      <input type="text" id="scan-rename-input" value="${esc(currentScan?.nom || '')}" placeholder="Nouveau nom…"
             onkeydown="if(event.key==='Enter') confirmScanRename()">
      <button class="btn-confirm" onclick="confirmScanRename()">✓</button>
    </div>`;
  setTimeout(() => document.getElementById('scan-rename-input')?.focus(), 100);
}

async function confirmScanRename() {
  const val = document.getElementById('scan-rename-input')?.value.trim();
  if (!val || !currentScan) return;
  await renameProductEverywhere(currentScan.code, val);
  currentScan.nom = val;
  document.getElementById('scan-result-name').textContent = val;
  document.getElementById('scan-edit-area').innerHTML = '';
  showToast('Nom mis à jour ✓', 'success');
  renderRecent();
}

// ── Annulation ──
function undoRowHtml() {
  return `<div class="undo-row" id="undo-row">
    <button class="btn-undo" onclick="undoLast()">↩ Annuler</button>
    <div class="undo-timer"><div style="animation-duration:${UNDO_MS}ms"></div></div>
  </div>`;
}

function startUndo(info) {
  pendingUndo = info;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(finalizeUndo, UNDO_MS);
}

function finalizeUndo() {
  clearTimeout(undoTimer);
  pendingUndo = null;
  document.getElementById('undo-row')?.remove();
}

async function undoLast() {
  const u = pendingUndo;
  if (!u) return;
  finalizeUndo();
  await Store.removeHistoryEntry(u.date, u.entryId);
  await restoreCf(u.cfRestore);
  if (u.freezerIds) await removeFromFreezer(u.freezerIds);
  hideResult();
  renderRecent();
  showToast('Annulé ✓', 'success');
}

// ═══════════════════════════════════════
// MODE VIANDE — réception en rafale, même DLC
// ═══════════════════════════════════════
async function handleMeatScan(code) {
  const stock = await loadCfStock();
  const item = stock.find(s => s.codePhysique === code && s.dlc === meatModeDlc);
  if (item) {
    item.qty++;
    await saveCfStock();
    showResult(code, 'known', `
      <div class="result-name">${esc(item.nom)}</div>
      ${badge(...BADGE_BLUE, `🥩 +1 — total : ${item.qty} en stock (DLC ${formatDlcDisplay(item.dlc)})`)}`);
  } else if (produitsDict[code]) {
    await addMeatItem(code, produitsDict[code]);
  } else {
    showResult(code, 'unknown', `
      <div class="result-name unknown-label">Nouveau morceau — donne-lui un nom :</div>
      <input class="name-input" id="meat-name-input" type="text" placeholder="Ex : Flanchet avec os"
             onkeydown="if(event.key==='Enter') confirmMeatName(${jsArg(code)})">
      <button class="btn-save" style="margin-top:10px;" onclick="confirmMeatName(${jsArg(code)})">✓ Créer l'article</button>`);
    setTimeout(() => document.getElementById('meat-name-input')?.focus(), 100);
  }
}

async function addMeatItem(code, nom) {
  const stock = await loadCfStock();
  stock.push({
    id: newCfId(), nom, dlc: meatModeDlc, qty: 1, supplier: 'TRADIVAL',
    codeFacture: code, codePhysique: code, dateEntree: localDateStr(new Date())
  });
  await saveCfStock();
  showResult(code, 'known', `
    <div class="result-name">${esc(nom)}</div>
    ${badge(...BADGE_GREEN, `✓ Ajouté à la chambre froide — DLC ${formatDlcDisplay(meatModeDlc)}`)}`);
  showToast(`${nom} ajouté ✓`, 'success');
}

async function confirmMeatName(code) {
  const nom = document.getElementById('meat-name-input')?.value.trim();
  if (!nom) { showToast('Entre un nom', 'error'); return; }
  if (!produitsDict[code]) { produitsDict[code] = nom; await saveProduitsJson(); }
  document.activeElement?.blur();
  await addMeatItem(code, nom);
}

// ═══════════════════════════════════════
// MODE DLC — la DLC est choisie à chaque scan
// ═══════════════════════════════════════
async function handleDlcModeScan(code) {
  const nom = produitsDict[code] || null;
  const dlc = await pickDlc('DLC du produit', nom || `Code ${code}`);
  if (!dlc) { hideResult(); return; }
  if (!nom) {
    showResult(code, 'unknown', `
      <div class="result-name unknown-label">Produit inconnu — donne-lui un nom :</div>
      <input class="name-input" id="dlc-name-input" type="text" placeholder="Ex : Saucisson sec"
             onkeydown="if(event.key==='Enter') confirmDlcModeName(${jsArg(code)}, ${jsArg(dlc)})">
      <button class="btn-save" style="margin-top:10px;" onclick="confirmDlcModeName(${jsArg(code)}, ${jsArg(dlc)})">✓ Ranger en chambre froide</button>`);
    setTimeout(() => document.getElementById('dlc-name-input')?.focus(), 100);
    return;
  }
  await addToColdStorageWithDlc(code, nom, dlc);
}

async function confirmDlcModeName(code, dlc) {
  const nom = document.getElementById('dlc-name-input')?.value.trim();
  if (!nom) { showToast('Entre un nom', 'error'); return; }
  if (!produitsDict[code]) { produitsDict[code] = nom; await saveProduitsJson(); }
  document.activeElement?.blur();
  await addToColdStorageWithDlc(code, nom, dlc);
}

async function addToColdStorageWithDlc(code, nom, dlc, qty = 1, extraHtml = '') {
  const stock = await loadCfStock();
  const dateEntree = localDateStr(new Date());
  // Même code, même DLC, entré le même jour : on regroupe dans le même lot
  let item = stock.find(s => (s.codePhysique === code || s.codeFacture === code) && s.dlc === dlc && s.dateEntree === dateEntree);
  if (item) item.qty += qty;
  else {
    item = { id: newCfId(), nom, dlc, qty, supplier: 'Saisie manuelle',
             codeFacture: code, codePhysique: code, dateEntree };
    stock.push(item);
  }
  await saveCfStock();
  showResult(code, 'known', `
    <div class="result-name">${esc(nom)}</div>
    ${badge(...BADGE_BLUE, `🧊 Rangé en chambre froide — DLC ${formatDlcDisplay(dlc)} — total : ${item.qty}`)}
    ${extraHtml}`);
  showToast(`${nom} ajouté ✓`, 'success');
}

// ═══════════════════════════════════════
// CHOIX DANS LA CHAMBRE FROIDE (sans code-barres)
// ═══════════════════════════════════════
let cfPickerItems = [];
let cfPickerAction = 'sortie'; // 'sortie' (tuile) | 'ouverture' (mode ouverture)
let cfPickerFilter = null;     // null | 'urgent'
let cfLot = null;              // lot ouvert dans la fiche d'action : { id, qty }

// filter 'urgent' : seulement les lots à DLC dépassée ou proche (bandeau d'alerte)
async function openCfPicker(action = 'sortie', filter = null) {
  cfPickerAction = action;
  cfPickerFilter = filter;
  cfLot = null;
  document.getElementById('cf-picker-title').textContent =
    action === 'ouverture' ? '🍽️ Quel produit est entamé ?'
    : filter === 'urgent' ? '⚠️ DLC dépassée ou proche' : '📤 Sortir de la chambre froide';
  document.getElementById('cf-picker-modal').style.display = 'flex';
  document.getElementById('cf-picker-search').value = '';
  document.getElementById('cf-picker-search').parentElement.style.display = '';
  const stock = await loadCfStock();
  if (filter === 'urgent') {
    // Les plus urgents d'abord
    cfPickerItems = stock.filter(s => dlcLevel(s.dlc) !== 'ok')
      .sort((a, b) => (a.dlc || '').localeCompare(b.dlc || ''));
  } else {
    // Chaque lot séparément (DLC et date d'entrée différentes), par nom puis DLC la plus proche
    cfPickerItems = [...stock].sort((a, b) => (a.nom || '').localeCompare(b.nom || '', 'fr')
      || (a.dlc || '9999-12-31').localeCompare(b.dlc || '9999-12-31'));
  }
  renderCfPickerList('');
}

function renderCfPickerList(q) {
  const list = document.getElementById('cf-picker-list');
  const filtered = q.trim()
    ? cfPickerItems.filter(s => (s.nom || '').toLowerCase().includes(q.toLowerCase()))
    : cfPickerItems;
  if (!filtered.length) {
    list.innerHTML = '<div style="padding:16px;font-size:14px;color:var(--text-dim);">Aucun article trouvé</div>';
    return;
  }
  list.innerHTML = filtered.map(s => {
    const code = s.codePhysique || s.codeFacture || '';
    return `<div class="cf-picker-item lvl-${dlcLevel(s.dlc)}" onclick="pickCfItem(${jsArg(s.id)})">
      <div class="cf-picker-item-nom">${esc(s.nom || 'Sans nom')} <span class="cf-picker-qty">×${s.qty ?? '—'}</span></div>
      <div class="cf-picker-item-meta">${dlcText(s.dlc)}${s.dateEntree ? ` · entré le ${formatDlcDisplay(s.dateEntree)}` : ''}${code ? ` · ${esc(code)}` : ''}</div>
    </div>`;
  }).join('');
}

// Ouverture : noté tout de suite. Sortie : fiche du lot (quantité, sortir / jeté / congeler / étiquette)
function pickCfItem(id) {
  if (cfPickerAction === 'ouverture') {
    closeCfPickerModal();
    runLotAction(id, 'ouverture', 1);
    return;
  }
  const item = cfStock.find(s => s.id === id);
  if (!item) return;
  cfLot = { id, qty: 1 };
  document.getElementById('cf-picker-search').parentElement.style.display = 'none';
  renderLotSheet();
}

function renderLotSheet() {
  const item = cfStock.find(s => s.id === cfLot.id);
  if (!item) { closeCfPickerModal(); return; }
  const code = item.codePhysique || item.codeFacture || '';
  const many = item.qty > 1;
  document.getElementById('cf-picker-list').innerHTML = `
    <div class="cf-add-form">
      <div>
        <div class="result-name">${esc(item.nom)}</div>
        <div class="cf-picker-item-meta lvl-${dlcLevel(item.dlc)}" style="font-size:13px;margin-top:4px;">
          ${dlcText(item.dlc)} · ${item.qty} en stock${item.dateEntree ? ` · entré le ${formatDlcDisplay(item.dateEntree)}` : ''}</div>
      </div>
      ${many ? `<div class="cf-add-row">
        <span>Combien ?</span>
        <div class="qty-stepper">
          <button onclick="lotStep(-1)">−</button>
          <span class="qty-value" id="lot-qty">${cfLot.qty}</span>
          <button onclick="lotStep(1)">+</button>
          <button class="qty-all" onclick="lotStep(${item.qty})">Tout</button>
        </div>
      </div>` : ''}
      <div class="lot-actions">
        <button class="lot-btn out" id="lot-sortie" onclick="lotAction('sortie')">📤 Sortir</button>
        <button class="lot-btn waste" id="lot-perte" onclick="lotAction('perte')">🗑️ Jeté (perte)</button>
        <button class="lot-btn freeze" id="lot-congelation" onclick="lotAction('congelation')">❄️ Congeler</button>
        ${code ? `<button class="lot-btn" onclick="printLotLabels(${jsArg(code)}, ${jsArg(item.nom)}, ${jsArg(item.dlc)}, ${jsArg(item.dateEntree || '')}, cfLot.qty)">🖨️ Étiquette</button>` : ''}
      </div>
      <button class="btn-edit" onclick="openCfPicker(cfPickerAction, cfPickerFilter)">← Retour à la liste</button>
    </div>`;
}

function lotStep(delta) {
  const item = cfStock.find(s => s.id === cfLot.id);
  cfLot.qty = Math.max(1, Math.min(item.qty, cfLot.qty + delta));
  document.getElementById('lot-qty').textContent = cfLot.qty;
}

function lotAction(kind) {
  const { id, qty } = cfLot;
  closeCfPickerModal();
  runLotAction(id, kind, qty);
}

// Sortie / perte / congélation / ouverture d'un lot choisi, comme si on l'avait scanné — quel que soit le mode
function runLotAction(id, kind, qty) {
  if (tabIsNot('scan')) switchTab('scan');
  scanQueue = scanQueue.then(async () => {
    finalizeUndo();
    const item = (await loadCfStock()).find(s => s.id === id);
    if (!item) return;
    const code = item.codePhysique || item.codeFacture || '';
    if (kind === 'ouverture') await recordExit(code, item.nom, item, true);
    else await recordExit(code, item.nom, item, false, { kind, qty });
  });
}

function closeCfPickerModal() { cfLot = null; document.getElementById('cf-picker-modal').style.display = 'none'; }
function closeCfPickerOverlay(e) { if (e.target.id === 'cf-picker-modal') closeCfPickerModal(); }

// ═══════════════════════════════════════
// ALERTES DLC — bandeau de l'accueil
// ═══════════════════════════════════════
function daysLeft(dlc) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((new Date(dlc + 'T00:00:00') - today) / 86400000);
}
// 'expired' : dépassée · 'urgent' : aujourd'hui ou demain · 'soon' : dans 2 ou 3 jours · 'ok'
function dlcLevel(dlc) {
  if (!dlc) return 'ok';
  const d = daysLeft(dlc);
  return d < 0 ? 'expired' : d <= 1 ? 'urgent' : d <= 3 ? 'soon' : 'ok';
}
function dlcText(dlc) {
  if (!dlc) return 'Sans DLC';
  const d = daysLeft(dlc);
  const f = formatDlcDisplay(dlc);
  if (d < 0) return `🔴 DLC ${f} — dépassée de ${-d} j`;
  if (d === 0) return `🔴 DLC aujourd'hui`;
  if (d === 1) return `🟠 DLC demain`;
  if (d <= 3) return `🟡 DLC ${f} (${d} j)`;
  return `DLC ${f}`;
}

function renderDlcBanner() {
  const el = document.getElementById('dlc-banner');
  if (!el || !cfStock) return;
  const count = lvl => cfStock.filter(s => dlcLevel(s.dlc) === lvl).length;
  const [expired, urgent, soon] = [count('expired'), count('urgent'), count('soon')];
  if (!expired && !urgent && !soon) { el.innerHTML = ''; el.className = 'dlc-banner'; return; }
  const parts = [];
  if (expired) parts.push(`🔴 <strong>${expired}</strong> périmé${expired > 1 ? 's' : ''}`);
  if (urgent) parts.push(`🟠 <strong>${urgent}</strong> DLC aujourd'hui / demain`);
  if (soon) parts.push(`🟡 <strong>${soon}</strong> sous 3 jours`);
  el.className = `dlc-banner visible ${expired || urgent ? 'hot' : ''}`;
  el.innerHTML = `<span>${parts.join(' · ')}</span><span class="dlc-banner-go">Voir ›</span>`;
}

const tabIsNot = t => document.querySelector('.tab.active')?.dataset.tab !== t;

// ═══════════════════════════════════════
// METTRE EN CHAMBRE FROIDE — choisir ou créer l'article, puis DLC + quantité
// ═══════════════════════════════════════
// Les articles sont ceux de produits.json (scans + étiquettes). Un article créé ici reçoit
// un code d'étiquette « BA… » comme dans l'onglet Étiquettes : on peut l'imprimer, et le scanner le sortira.
let cfAdd = null;            // { code, nom, isNew, dlc, qty } une fois l'article choisi
let cfAddPendingCode = null; // code scanné inconnu : sera le code de l'article créé

const cfAddOpen = () => document.getElementById('cf-add-modal')?.style.display === 'flex';
const nomOf = v => typeof v === 'object' && v ? (v.nom || '') : String(v ?? '');

function openCfAdd() {
  cfAdd = null;
  cfAddPendingCode = null;
  document.getElementById('cf-add-modal').style.display = 'flex';
  renderCfAddSearch();
}

function closeCfAdd() {
  document.getElementById('cf-add-modal').style.display = 'none';
  cfAdd = null;
  cfAddPendingCode = null;
  document.activeElement?.blur();
}

function renderCfAddSearch() {
  document.getElementById('cf-add-body').innerHTML = `
    <div style="padding:10px 16px;">
      <input type="text" id="cf-add-search" class="name-input" autocomplete="off" style="width:100%;"
             placeholder="🔍 Chercher un article, ou taper le nom d'un nouveau…"
             oninput="renderCfAddList()" onkeydown="if(event.key==='Enter') cfAddEnter()">
    </div>
    <div class="cf-add-hint" id="cf-add-hint">📡 Tu peux aussi scanner l'étiquette du produit.</div>
    <div id="cf-add-recents"></div>
    <div id="cf-add-list"></div>`;
  renderCfAddList();
}

function cfAddMatches(q) {
  q = q.trim().toLowerCase();
  return Object.entries(produitsDict)
    .map(([code, v]) => ({ code, nom: nomOf(v) || code }))
    .filter(a => !q || a.nom.toLowerCase().includes(q) || a.code.toLowerCase() === q)
    .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
}

// Derniers articles rangés (sur cette tablette), en gros boutons
const RECENTS_KEY = 'sb_cf_recents';
function cfRecents() {
  try { return (JSON.parse(localStorage.getItem(RECENTS_KEY)) || []).filter(c => produitsDict[c]); } catch { return []; }
}
function pushCfRecent(code) {
  const list = [code, ...cfRecents().filter(c => c !== code)].slice(0, 8);
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(list)); } catch {}
}

function renderCfAddList() {
  const q = (document.getElementById('cf-add-search')?.value || '').trim();
  const recents = q ? [] : cfRecents();
  document.getElementById('cf-add-recents').innerHTML = recents.length ? `
    <div class="cf-add-hint">Derniers rangés :</div>
    <div class="recent-grid">${recents.map(c => `<button class="recent-btn" onclick="cfAddChoose(${jsArg(c)})">${esc(nomOf(produitsDict[c]) || c)}</button>`).join('')}</div>
    <div class="cf-add-hint">Tous les articles :</div>` : '';
  const matches = cfAddMatches(q);
  const exact = matches.some(a => a.nom.toLowerCase() === q.toLowerCase());
  const create = q && !exact
    ? `<div class="cf-add-item create" onclick="cfAddCreate()">➕ Créer l'article « ${esc(q)} »
        <small>${cfAddPendingCode ? esc(cfAddPendingCode) : 'nouvelle étiquette'}</small></div>`
    : '';
  const shown = matches.slice(0, 100);
  document.getElementById('cf-add-list').innerHTML = create + (shown.length
    ? shown.map(a => `<div class="cf-add-item" onclick="cfAddChoose(${jsArg(a.code)})">
        <span>${a.code.startsWith('BA') ? '🏷️' : '📦'} ${esc(a.nom)}</span><small>${esc(a.code)}</small></div>`).join('')
    : (create ? '' : '<div class="cf-add-hint">Aucun article — tape un nom pour le créer.</div>'));
}

function cfAddEnter() {
  const q = document.getElementById('cf-add-search').value.trim();
  if (!q) return;
  const matches = cfAddMatches(q);
  const exact = matches.find(a => a.nom.toLowerCase() === q.toLowerCase() || a.code === q);
  if (exact) cfAddChoose(exact.code);
  // La douchette a tapé dans le champ : c'est un code-barres, pas un nom
  else if (/^\d{6,}$/.test(q)) { document.getElementById('cf-add-search').value = ''; cfAddScan(q); }
  else if (matches.length === 1) cfAddChoose(matches[0].code);
  else cfAddCreate();
}

// Scan pendant que la fenêtre est ouverte : article connu → choisi, sinon on le crée avec ce code
function cfAddScan(code) {
  if (navigator.vibrate) navigator.vibrate(80);
  if (cfAdd) { showToast("Termine d'abord cet article", 'error'); return; }
  if (produitsDict[code]) { cfAddChoose(code); return; }
  cfAddPendingCode = code;
  document.getElementById('cf-add-hint').innerHTML = `📡 Code <strong>${esc(code)}</strong> inconnu — tape son nom puis « Créer ».`;
  document.getElementById('cf-add-search').focus();
  renderCfAddList();
}

async function cfAddCreate() {
  const nom = document.getElementById('cf-add-search').value.trim();
  if (!nom) { showToast('Entre un nom', 'error'); return; }
  const code = cfAddPendingCode || generateCode(nom);
  produitsDict[code] = nom;
  await saveProduitsJson();
  cfAddPendingCode = null;
  await cfAddChoose(code, true);
}

async function cfAddChoose(code, isNew = false) {
  document.activeElement?.blur();
  const a = { code, nom: nomOf(produitsDict[code]) || code, isNew, dlc: null, qty: 1 };
  cfAdd = a;
  const dlc = await pickDlc('DLC du lot', esc(a.nom));
  if (cfAdd !== a) return; // fenêtre fermée entre-temps
  if (!dlc) { cfAdd = null; renderCfAddSearch(); return; }
  a.dlc = dlc;
  renderCfAddForm();
}

function renderCfAddForm() {
  const a = cfAdd;
  document.getElementById('cf-add-body').innerHTML = `
    <div class="cf-add-form">
      <div>
        <div class="result-name">${esc(a.nom)}</div>
        <div style="font-family:monospace;font-size:12px;color:var(--text-dim);">${esc(a.code)}${a.isNew ? ' · article créé ✓' : ''}</div>
      </div>
      <div class="cf-add-row">
        <span>📅 DLC : <strong>${formatDlcDisplay(a.dlc)}</strong></span>
        <button class="btn-edit" onclick="cfAddChangeDlc()">Changer</button>
      </div>
      <div class="cf-add-row">
        <span>Quantité</span>
        <div class="qty-stepper">
          <button onclick="cfAddStep(-1)">−</button>
          <span class="qty-value" id="cf-add-qty">${a.qty}</span>
          <button onclick="cfAddStep(1)">+</button>
        </div>
      </div>
      <div class="cf-add-row" style="color:var(--text-dim);font-size:13px;">Date d'entrée : aujourd'hui (${formatDlcDisplay(localDateStr(new Date()))})</div>
      <button class="btn-save" id="cf-add-confirm" onclick="cfAddConfirm()">🧊 Ranger en chambre froide</button>
      <button class="btn-edit" onclick="cfAdd=null;renderCfAddSearch()">← Choisir un autre article</button>
    </div>`;
}

async function cfAddChangeDlc() {
  const dlc = await pickDlc('DLC du lot', esc(cfAdd?.nom || ''));
  if (!dlc || !cfAdd) return;
  cfAdd.dlc = dlc;
  renderCfAddForm();
}

function cfAddStep(delta) {
  cfAdd.qty = Math.max(1, cfAdd.qty + delta);
  document.getElementById('cf-add-qty').textContent = cfAdd.qty;
}

async function cfAddConfirm() {
  const a = cfAdd;
  if (!a || !a.dlc) return;
  closeCfAdd();
  finalizeUndo();
  pushCfRecent(a.code);
  // Étiquette maison : on propose de l'imprimer tout de suite (avec la DLC), pour pouvoir la scanner à la sortie
  const today = localDateStr(new Date());
  const print = a.code.startsWith('BA')
    ? `<button class="btn-print" style="margin-top:10px;" onclick="printLotLabels(${jsArg(a.code)}, ${jsArg(a.nom)}, ${jsArg(a.dlc)}, ${jsArg(today)}, ${a.qty})">🖨️ Imprimer ${a.qty > 1 ? `les ${a.qty} étiquettes` : "l'étiquette"}</button>`
    : '';
  await addToColdStorageWithDlc(a.code, a.nom, a.dlc, a.qty, print);
}

// ═══════════════════════════════════════
// DERNIERS SCANS DU JOUR
// ═══════════════════════════════════════
async function renderRecent() {
  const el = document.getElementById('recent-list');
  const today = await Store.loadDay(localDateStr(new Date()));
  if (!today.length) { el.innerHTML = ''; return; }
  const last = today.slice(-6).reverse();
  el.innerHTML = `<div class="recent-title">Aujourd'hui · ${today.length} scan${today.length > 1 ? 's' : ''}</div>
    ${last.map(e => `<div class="recent-item">
      <span>${actionIcon(e)}${esc(e.nom)}${e.qty > 1 ? ` ×${e.qty}` : ''}</span><span class="recent-time">${esc(e.heure)}</span>
    </div>`).join('')}`;
}

// ═══════════════════════════════════════
// HISTORIQUE
// ═══════════════════════════════════════
async function loadHistory() {
  const el = document.getElementById('history-content');
  el.innerHTML = '<div class="loading"><span class="spinner"></span>Chargement…</div>';
  const days = await Store.listDays();
  allEntries = [];
  const counts = {};
  for (const d of days) {
    const entries = await Store.loadDay(d);
    counts[d] = entries.length;
    entries.forEach(e => allEntries.push({ ...e, date: d }));
  }
  if (!days.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">Aucun scan enregistré</div></div>';
    return;
  }
  el.innerHTML = `<div class="days-list">${days.map(d => `
    <div class="day-card" onclick="showDay(${jsArg(d)})">
      <span class="day-date">${formatDate(d)}</span>
      <span class="day-count">${counts[d]} produit${counts[d] > 1 ? 's' : ''}</span>
    </div>`).join('')}</div>`;
}

async function showDay(date) {
  const el = document.getElementById('history-content');
  const entries = await Store.loadDay(date);
  el.innerHTML = `
    <button class="back-btn" onclick="loadHistory()">← Retour</button>
    <div class="day-title">${formatDate(date)}</div>
    <div class="entries-list">
      ${entries.length ? entries.slice().reverse().map(renderEntry).join('')
        : '<div class="empty-state"><div class="empty-text">Aucune entrée</div></div>'}
    </div>`;
}

const ACTION_ICONS = { ouverture: '🍽️ ', perte: '🗑️ ', congelation: '❄️ ' };
const actionIcon = e => ACTION_ICONS[e.action] || '';

function renderEntry(e) {
  return `<div class="entry-card">
    <div class="entry-top">
      <div class="entry-name">${actionIcon(e)}${esc(e.nom)}${e.qty > 1 ? ` ×${e.qty}` : ''}</div>
      <div style="display:flex;align-items:center;gap:8px;">
        <div class="entry-time">${esc(e.heure)}</div>
        <button class="btn-edit" onclick="renameProduct(${jsArg(e.code)}, ${jsArg(e.nom || '')})">✏️</button>
      </div>
    </div>
    <div class="entry-code">${esc(e.code)}</div>
  </div>`;
}

function handleSearch() {
  const q = document.getElementById('search-input').value.trim().toLowerCase();
  const el = document.getElementById('history-content');
  if (!q) { loadHistory(); return; }
  const results = allEntries.filter(e => (e.nom && e.nom.toLowerCase().includes(q)) || (e.code || '').toLowerCase().includes(q));
  if (!results.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-text">Aucun résultat</div></div>';
    return;
  }
  const grouped = {};
  results.forEach(e => { (grouped[e.nom] = grouped[e.nom] || []).push(e); });
  el.innerHTML = `
    <div class="search-results-title">${results.length} résultat${results.length > 1 ? 's' : ''}</div>
    <div class="entries-list">
      ${Object.entries(grouped).map(([nom, items]) => `
        <div class="entry-card">
          <div class="entry-name">${esc(nom)}</div>
          <div class="entry-code">${esc(items[0].code)}</div>
          <div style="margin-top:8px;display:flex;flex-direction:column;gap:4px;">
            ${items.map(i => `<div style="font-size:12px;color:var(--text-dim);">${formatDate(i.date)} à ${esc(i.heure)}</div>`).join('')}
          </div>
        </div>`).join('')}
    </div>`;
}

async function renameProduct(code, currentNom) {
  const newNom = prompt(`Renommer « ${currentNom} » :`, currentNom);
  if (!newNom || newNom.trim() === currentNom) return;
  await renameProductEverywhere(code, newNom.trim());
  showToast(`Renommé en « ${newNom.trim()} » ✓`, 'success');
  loadHistory();
}

// Renomme dans le dictionnaire et dans tout l'historique
async function renameProductEverywhere(code, nom) {
  produitsDict[code] = nom;
  await saveProduitsJson();
  for (const d of await Store.listDays()) {
    const entries = await Store.loadDay(d);
    let changed = false;
    for (const e of entries) if (e.code === code && e.nom !== nom) { e.nom = nom; changed = true; }
    if (changed) await Store.saveDay(d, entries);
  }
  allEntries = allEntries.map(e => e.code === code ? { ...e, nom } : e);
}

// ═══════════════════════════════════════
// ÉTIQUETTES
// ═══════════════════════════════════════
function generateCode(nom) {
  const ts = Date.now().toString(36).toUpperCase();
  const hash = nom.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) & 0xFFFF, 0).toString(16).toUpperCase().padStart(4, '0');
  return `BA${hash}${ts}`;
}

async function createLabel() {
  const input = document.getElementById('label-name-input');
  const nom = input.value.trim();
  if (!nom) { showToast('Entre un nom de produit', 'error'); return; }
  const code = generateCode(nom);
  produitsDict[code] = nom;
  await saveProduitsJson();
  showBarcode(code, nom);
  input.value = '';
  showToast('Étiquette créée ✓', 'success');
  loadLabels();
}

function showBarcode(code, nom) {
  document.getElementById('barcode-nom').textContent = nom;
  document.getElementById('barcode-code-display').textContent = code;
  document.getElementById('barcode-preview').className = 'barcode-preview visible';
  JsBarcode('#barcode-svg', code, { format: 'CODE128', width: 2, height: 60, displayValue: false, margin: 8 });
}

// Impression : la fenêtre d'impression Android (window.print ne marche pas dans une app)
function doPrint() {
  if (Native.available) Native.plugin.print({ name: 'Étiquettes' }).catch(() => showToast('Impression impossible', 'error'));
  else window.print();
}

function printBarcode() {
  const nom = document.getElementById('barcode-nom').textContent;
  const code = document.getElementById('barcode-code-display').textContent;
  document.getElementById('print-area').innerHTML = `
    <div style="text-align:center;font-family:sans-serif;padding:20px;">
      <div style="font-size:20px;font-weight:700;margin-bottom:8px;">${esc(nom)}</div>
      <svg id="print-barcode-svg"></svg>
      <div style="font-family:monospace;font-size:12px;margin-top:6px;color:#666;">${esc(code)}</div>
    </div>`;
  JsBarcode('#print-barcode-svg', code, { format: 'CODE128', width: 3, height: 80, displayValue: false, margin: 10 });
  doPrint();
}

// Étiquettes d'un lot : nom, code-barres, DLC et date d'entrée — une par pièce
function printLotLabels(code, nom, dlc, dateEntree, copies = 1) {
  const n = Math.max(1, Math.min(copies, 50));
  document.getElementById('print-area').innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:16px;padding:20px;">${
    Array.from({ length: n }, (_, i) => `
    <div style="text-align:center;border:1px solid #ccc;border-radius:8px;padding:12px;min-width:200px;font-family:sans-serif;">
      <div style="font-size:16px;font-weight:700;margin-bottom:6px;">${esc(nom)}</div>
      <svg id="lot-svg-${i}"></svg>
      <div style="font-size:15px;font-weight:700;margin-top:4px;">DLC ${esc(formatDlcDisplay(dlc))}</div>
      ${dateEntree ? `<div style="font-size:12px;color:#444;">Entré le ${esc(formatDlcDisplay(dateEntree))}</div>` : ''}
      <div style="font-family:monospace;font-size:10px;color:#666;margin-top:2px;">${esc(code)}</div>
    </div>`).join('')}</div>`;
  for (let i = 0; i < n; i++) {
    JsBarcode('#lot-svg-' + i, code, { format: 'CODE128', width: 2, height: 50, displayValue: false, margin: 6 });
  }
  doPrint();
}

async function loadLabels() {
  selectedLabels.clear();
  const el = document.getElementById('labels-list-content');
  const labels = Object.entries(produitsDict).filter(([code]) => code.startsWith('BA'));
  if (!labels.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">🏷️</div><div class="empty-text">Aucune étiquette créée</div></div>';
    return;
  }
  if (!allEntries.length) await loadAllEntries();
  const lastUse = {};
  allEntries.forEach(e => { if (!lastUse[e.code] || e.date > lastUse[e.code].date) lastUse[e.code] = e; });
  el.innerHTML = `
    <div class="label-select-bar" id="label-select-bar">
      <span id="select-count">0 sélectionné</span>
      <div style="display:flex;gap:8px;">
        <button class="btn-cancel-select" onclick="clearLabelSelection()">Annuler</button>
        <button class="btn-print-selected" onclick="printSelected()">🖨️ Imprimer</button>
      </div>
    </div>
    <div style="font-size:13px;color:var(--text-dim);font-weight:500;">${labels.length} étiquette${labels.length > 1 ? 's' : ''} — <span style="color:var(--accent)">appuie pour sélectionner</span></div>
    <div class="labels-list">
      ${labels.map(([code, nom]) => {
        const last = lastUse[code];
        return `<div class="label-card" id="lcard-${esc(code)}" onclick="toggleLabelSelect(${jsArg(code)})">
          <div class="label-checkbox" id="lchk-${esc(code)}"></div>
          <div style="flex:1;">
            <div class="label-card-name">${esc(nom)}</div>
            <div class="label-card-code">${esc(code)}</div>
            ${last ? `<div class="label-card-last">Dernier scan : ${formatDate(last.date)} à ${esc(last.heure)}</div>` : '<div class="label-card-last" style="color:var(--accent)">Jamais scanné</div>'}
          </div>
          <button class="btn-show-barcode" onclick="event.stopPropagation();showBarcode(${jsArg(code)}, ${jsArg(nom)})">📄</button>
        </div>`;
      }).join('')}
    </div>`;
}

async function loadAllEntries() {
  allEntries = [];
  for (const d of await Store.listDays()) (await Store.loadDay(d)).forEach(e => allEntries.push({ ...e, date: d }));
}

function toggleLabelSelect(code) {
  const on = !selectedLabels.has(code);
  if (on) selectedLabels.add(code); else selectedLabels.delete(code);
  document.getElementById('lcard-' + code)?.classList.toggle('selected', on);
  document.getElementById('lchk-' + code).textContent = on ? '✓' : '';
  updateSelectBar();
}

function updateSelectBar() {
  const bar = document.getElementById('label-select-bar');
  if (!bar) return;
  bar.classList.toggle('visible', selectedLabels.size > 0);
  document.getElementById('select-count').textContent = `${selectedLabels.size} sélectionné${selectedLabels.size > 1 ? 's' : ''}`;
}

function clearLabelSelection() {
  selectedLabels.forEach(code => {
    document.getElementById('lcard-' + code)?.classList.remove('selected');
    document.getElementById('lchk-' + code).textContent = '';
  });
  selectedLabels.clear();
  updateSelectBar();
}

function printSelected() {
  if (!selectedLabels.size) return;
  const codes = [...selectedLabels];
  document.getElementById('print-area').innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:16px;padding:20px;">${codes.map((code, i) => `
    <div style="text-align:center;border:1px solid #ccc;border-radius:8px;padding:12px;min-width:160px;">
      <div style="font-size:14px;font-weight:700;margin-bottom:6px;">${esc(produitsDict[code] || code)}</div>
      <svg id="psvg-${i}"></svg>
      <div style="font-family:monospace;font-size:10px;color:#666;margin-top:4px;">${esc(code)}</div>
    </div>`).join('')}</div>`;
  codes.forEach((code, i) => JsBarcode('#psvg-' + i, code, { format: 'CODE128', width: 2, height: 50, displayValue: false, margin: 6 }));
  doPrint();
}

// ═══════════════════════════════════════
// CONGÉLATEUR
// ═══════════════════════════════════════
async function saveFreezerJson() { await Store.save('congelateur.json', freezerItems); }

async function loadFreezer() {
  freezerItems = (await Store.load('congelateur.json')) || [];
  renderFreezer();
}

function renderFreezer() {
  const el = document.getElementById('freezer-content');
  if (!freezerItems.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">❄️</div><div class="empty-text">Congélateur vide</div></div>';
    return;
  }
  el.innerHTML = `
    <div class="freezer-header"><div class="freezer-count">${freezerItems.length} produit${freezerItems.length > 1 ? 's' : ''}</div></div>
    <div class="freezer-list">
      ${freezerItems.map((item, i) => `
        <div class="freezer-card">
          <div style="font-size:24px;">❄️</div>
          <div class="freezer-card-info">
            <div class="freezer-card-name">${esc(item.nom)}</div>
            <div class="freezer-card-date">Entré le ${formatDate(item.date)}</div>
            <div class="freezer-card-age">${daysAgo(item.date)}</div>
          </div>
          <button class="btn-remove" onclick="removeFreezerItem(${i})">🗑️</button>
        </div>`).join('')}
    </div>`;
}

function daysAgo(dateStr) {
  const diff = Math.floor((Date.now() - new Date(dateStr + 'T00:00:00')) / 86400000);
  if (diff <= 0) return "Entré aujourd'hui";
  if (diff === 1) return 'Il y a 1 jour';
  return `Il y a ${diff} jours`;
}

// Passage chambre froide → congélateur : une ligne par pièce ; renvoie les id (pour « Annuler »)
async function addToFreezer(nom, code, qty = 1) {
  freezerItems = (await Store.load('congelateur.json')) || [];
  const date = localDateStr(new Date());
  const ids = [];
  for (let i = 0; i < qty; i++) {
    const id = 'fz_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    freezerItems.unshift({ id, nom, code: code || '', date });
    ids.push(id);
  }
  await saveFreezerJson();
  return ids;
}

async function removeFromFreezer(ids) {
  freezerItems = ((await Store.load('congelateur.json')) || []).filter(f => !ids.includes(f.id));
  await saveFreezerJson();
}

async function addFreezerItem(nom, code) {
  freezerItems.unshift({ nom, code: code || '', date: localDateStr(new Date()) });
  await saveFreezerJson();
  renderFreezer();
  showToast(`${nom} ajouté au congélateur ✓`, 'success');
}

async function removeFreezerItem(index) {
  const item = freezerItems[index];
  if (!confirm(`Retirer « ${item.nom} » du congélateur ?`)) return;
  freezerItems.splice(index, 1);
  await saveFreezerJson();
  renderFreezer();
  showToast('Retiré ✓', 'success');
}

function queueFreezerScan(code) {
  scanQueue = scanQueue.then(async () => {
    if (navigator.vibrate) navigator.vibrate(80);
    const nom = produitsDict[code];
    if (nom) { await addFreezerItem(nom, code); return; }
    const input = document.getElementById('freezer-manual-input');
    input.value = '';
    input.placeholder = `Nom pour ${code}…`;
    input.dataset.pendingCode = code;
    input.focus();
    showToast('Produit inconnu — entre le nom', 'error');
  });
}

async function addFreezerManual() {
  const input = document.getElementById('freezer-manual-input');
  const nom = input.value.trim();
  if (!nom) return;
  const pendingCode = input.dataset.pendingCode || '';
  if (pendingCode && !produitsDict[pendingCode]) { produitsDict[pendingCode] = nom; await saveProduitsJson(); }
  await addFreezerItem(nom, pendingCode);
  input.value = '';
  input.placeholder = 'Nom du produit…';
  delete input.dataset.pendingCode;
  input.blur();
}

// ═══════════════════════════════════════
// RÉGLAGES — douchette, permissions, données
// ═══════════════════════════════════════
let bondedDevices = null;

async function loadSettings() {
  const el = document.getElementById('settings-content');
  const s = await Native.status().catch(() => null);
  const counts = {
    produits: Object.keys(produitsDict).length,
    cf: (await loadCfStock()).length,
    jours: (await Store.listDays()).length,
  };
  const last = Store.lastBackup();

  if (!s) {
    el.innerHTML = `<div class="settings-card"><h3>Mode navigateur</h3>
      <div class="settings-desc">Les réglages de la douchette n'existent que dans l'app installée sur la tablette.</div></div>
      ${dataCardHtml(counts, last)}`;
    return;
  }

  if (s.bluetoothGranted && bondedDevices === null) {
    bondedDevices = (await Native.plugin.listBondedDevices().catch(() => ({ devices: [] }))).devices || [];
  }

  const perm = (ok, label, hint, action) => `
    <div class="settings-row">
      <div class="settings-label">${label}<small>${hint}</small></div>
      ${ok ? '<span class="status-ok">✓ OK</span>' : `<button class="btn-action" onclick="${action}">Autoriser</button>`}
    </div>`;

  el.innerHTML = `
    <div class="settings-card">
      <h3>📡 Douchette Bluetooth</h3>
      <div class="settings-desc">Quand cette douchette se connecte à la tablette, l'app passe devant tout le reste.
        Elle doit d'abord être appairée dans les réglages Bluetooth d'Android.</div>
      ${!s.bluetoothGranted ? `<button class="btn-action" onclick="askBluetooth()">Autoriser le Bluetooth</button>` : `
        <div class="device-list">
          ${(bondedDevices || []).length ? bondedDevices
              .slice().sort((a, b) => b.likelyScanner - a.likelyScanner)
              .map(d => `<div class="device-item ${d.address === s.targetAddress ? 'selected' : ''}"
                  onclick="chooseScanner(${jsArg(d.address)}, ${jsArg(d.name)})">
                <span>${d.likelyScanner ? '🔫' : '📱'} ${esc(d.name)}</span>
                <small>${d.address === s.targetAddress ? '✓ choisie' : esc(d.address)}</small>
              </div>`).join('')
            : '<div class="settings-desc">Aucun appareil appairé.</div>'}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn-action secondary" onclick="Native.plugin.openBluetoothSettings()">⚙️ Appairer une douchette</button>
          <button class="btn-action secondary" onclick="bondedDevices=null;loadSettings()">🔄 Actualiser</button>
        </div>`}
    </div>

    <div class="settings-card">
      <h3>🔓 Autorisations</h3>
      <div class="settings-desc">Nécessaires pour que l'app reste active et passe au premier plan toute seule.</div>
      ${perm(s.bluetoothGranted, 'Bluetooth', 'Détecter la douchette', 'askBluetooth()')}
      ${perm(s.notificationsGranted, 'Notifications', 'Notification permanente « Scanner actif »', 'askNotifications()')}
      ${perm(s.overlayGranted, 'Superposition', 'Passer devant les autres apps', 'Native.plugin.openOverlaySettings()')}
      ${perm(s.batteryUnrestricted, 'Batterie sans restriction', "Android ne coupe pas l’app", 'Native.plugin.openBatterySettings()')}
      <div class="settings-row">
        <div class="settings-label">Surveillance active<small>${s.serviceRunning ? 'En marche' : 'Arrêtée'}</small></div>
        <label class="switch"><input type="checkbox" ${s.watchEnabled ? 'checked' : ''} onchange="setWatch(this.checked)"><span></span></label>
      </div>
      <div class="settings-row">
        <div class="settings-label">Écran toujours allumé<small>Tant que l'app est ouverte</small></div>
        <label class="switch"><input type="checkbox" ${s.keepScreenOn ? 'checked' : ''} onchange="Native.plugin.setKeepScreenOn({on:this.checked})"><span></span></label>
      </div>
    </div>

    <div class="settings-card">
      <h3>🔔 Rappel DLC du matin</h3>
      <div class="settings-desc">Chaque jour à <strong>${esc(s.dlcAlarmTime || '7h20')}</strong>, une notification liste les lots de la chambre froide
        dont la DLC est dépassée, aujourd'hui ou demain. Rien n'est envoyé s'il n'y en a pas.</div>
      ${perm(s.notificationsGranted, 'Notifications', 'Sans elles, le rappel ne peut pas s’afficher', 'askNotifications()')}
      ${perm(s.exactAlarmAllowed, 'Heure exacte', 'Sinon Android peut le décaler de quelques minutes', 'Native.plugin.openExactAlarmSettings()')}
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn-action secondary" onclick="testDlcAlert()">🔔 Tester maintenant</button>
      </div>
    </div>

    ${dataCardHtml(counts, last)}`;
}

async function testDlcAlert() {
  const r = await Native.plugin.testDlcAlert().catch(() => null);
  if (!r) showToast('Test impossible', 'error');
  else if (!r.count) showToast('Aucun lot à DLC courte — pas de notification', 'success');
  else showToast(`Notification envoyée (${r.count} lot${r.count > 1 ? 's' : ''}) ✓`, 'success');
}

function dataCardHtml(counts, last) {
  return `
    <div class="settings-card">
      <h3>💾 Données</h3>
      <div class="settings-desc">${counts.produits} produits · ${counts.cf} lots en chambre froide · ${counts.jours} jours d'historique<br>
        Sauvegarde automatique chaque jour dans <strong>Téléchargements/ScannerBoucherie</strong> (14 dernières gardées).
        ${last ? `Dernière : ${formatDlcDisplay(last)}.` : 'Aucune sauvegarde pour l\'instant.'}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn-action" onclick="document.getElementById('zip-input').click()">📥 Importer (ZIP Drive ou sauvegarde)</button>
        <button class="btn-action secondary" onclick="manualBackup()">💾 Sauvegarder maintenant</button>
      </div>
      <input type="file" id="zip-input" accept=".zip,application/zip" multiple style="display:none" onchange="importZipFiles(this.files)">
    </div>`;
}

async function askBluetooth() {
  try { await Native.plugin.requestBluetooth(); bondedDevices = null; }
  catch { showToast('Permission refusée — à activer dans les réglages Android', 'error'); }
  loadSettings();
  refreshScannerPill();
}

async function askNotifications() {
  await Native.plugin.requestNotifications().catch(() => {});
  loadSettings();
}

async function chooseScanner(address, name) {
  await Native.plugin.setTarget({ address, name });
  showToast(`Douchette : ${name} ✓`, 'success');
  loadSettings();
  refreshScannerPill();
}

async function setWatch(on) {
  await Native.plugin.setWatchEnabled({ enabled: on });
  setTimeout(loadSettings, 500);
}

async function manualBackup() {
  try {
    const name = await Store.backupNow();
    showToast(`Sauvegardé : ${name} ✓`, 'success');
  } catch (e) {
    showToast('Sauvegarde impossible', 'error');
    console.error(e);
  }
  loadSettings();
}

async function importZipFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  try {
    const found = await Store.parseZips(files);
    const s = Store.summarize(found);
    if (!s.produits && !s.chambreFroide && !s.congelateur && !s.jours) {
      showToast('Aucune donnée reconnue dans ce ZIP', 'error');
      return;
    }
    const ok = confirm(`Importer ?\n\n• ${s.produits} produits\n• ${s.chambreFroide} lots en chambre froide\n• ${s.congelateur} produits au congélateur\n• ${s.liaisons} liaisons de codes\n• ${s.jours} jours d'historique (${s.scans} scans)\n\nLes produits, la chambre froide et le congélateur de la tablette seront REMPLACÉS par ceux du ZIP. L'historique est fusionné.`);
    if (!ok) return;
    await Store.applyImport(found);
    showToast('Import terminé ✓', 'success');
    setTimeout(() => location.reload(), 800);
  } catch (e) {
    console.error(e);
    showToast('ZIP illisible', 'error');
  } finally {
    document.getElementById('zip-input').value = '';
  }
}

// ═══════════════════════════════════════
// UI
// ═══════════════════════════════════════
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${tab}`));
  document.activeElement?.blur();
  if (tab === 'history') loadHistory();
  if (tab === 'labels') loadLabels();
  if (tab === 'freezer') loadFreezer();
  if (tab === 'settings') loadSettings();
  if (tab === 'scan') renderRecent();
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

let toastTimer;
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2500);
}

// ═══════════════════════════════════════
// DÉMARRAGE
// ═══════════════════════════════════════
window.addEventListener('load', async () => {
  produitsDict = (await Store.load('produits.json')) || {};
  ScanCapture.start(onBarcode);
  renderModeContext();
  renderRecent();
  await loadCfStock();
  renderDlcBanner();
  // Le bandeau change avec la date : on le recalcule régulièrement (l'app reste ouverte des jours)
  setInterval(renderDlcBanner, 15 * 60 * 1000);

  // Arrivée depuis une autre page : scan à traiter, ou réglages demandés
  const hash = decodeURIComponent(location.hash.slice(1));
  history.replaceState(null, '', location.pathname);
  if (hash.startsWith('scan=')) { queueScan(hash.slice(5)); }
  else if (hash.startsWith('lot=')) { openCfPicker('sortie'); pickCfItem(hash.slice(4)); }
  else if (hash === 'dlc') { openCfPicker('sortie', 'urgent'); }
  else if (hash === 'reglages') { switchTab('settings'); }
  else if (await Native.plugin?.takeDlcAlert().then(r => r.opened).catch(() => false)) {
    openCfPicker('sortie', 'urgent'); // ouverte depuis le rappel DLC du matin
  }
  else {
    // Première ouverture sur la tablette : on commence par les réglages
    const s = await Native.status().catch(() => null);
    if (s && (!s.targetAddress || !Object.keys(produitsDict).length)) switchTab('settings');
  }

  Store.cleanOldDays().catch(console.error);
  Store.autoBackupIfNeeded();
  // L'app reste ouverte des jours entiers : on vérifie la sauvegarde toutes les heures
  setInterval(() => Store.autoBackupIfNeeded(), 3600 * 1000);
});

// Retour au premier plan (douchette connectée, ou retour depuis les réglages Android)
Native.onResume(() => {
  renderDlcBanner();
  if (document.querySelector('.tab.active')?.dataset.tab === 'settings') loadSettings();
  else renderRecent();
});
if (Native.available) Native.plugin.addListener('dlcAlertOpened', () => {
  if (tabIsNot('scan')) switchTab('scan');
  openCfPicker('sortie', 'urgent');
});
Native.onScannerConnected(() => {
  const tab = document.querySelector('.tab.active')?.dataset.tab;
  if (tab !== 'freezer' && tab !== 'scan') switchTab('scan');
  showToast('📡 Douchette connectée — prêt', 'success');
});
