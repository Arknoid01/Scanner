// ═══════════════════════════════════════
// PRODUITS MAISON — fabrications
// ═══════════════════════════════════════
// Une fabrication = un lot fait à la boutique (saucisses, pâté…) : date de fabrication, DLC, quantité,
// numéro de lot imprimé sur les étiquettes. Le lot est rangé en chambre froide comme les autres
// (code-barres = celui de l'article), donc la sortie se fait par le scan habituel.
// fabrications.json : [{ id, lot, code, nom, date, dlc, qty, cfId, createdAt }]

let fabrications = null;
let fab = null;             // fabrication en cours de saisie : { code, nom, isNew, date, dlc, qty, toCf }
let fabPendingCode = null;  // code scanné inconnu, en attente d'un article

const FAB_QUICK = [2, 3, 4, 5, 7, 10];

async function loadFabrications() {
  if (fabrications) return fabrications;
  fabrications = (await Store.load('fabrications.json')) || [];
  return fabrications;
}
async function saveFabrications() { await Store.save('fabrications.json', fabrications); }

const addDays = (date, n) => { const d = new Date(date + 'T00:00:00'); d.setDate(d.getDate() + n); return localDateStr(d); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);

// Numéro de lot : F + date de fabrication (AAMMJJ) + n° du jour → F261001-2
function nextLotNumber(date) {
  const prefix = 'F' + date.slice(2).replace(/-/g, '') + '-';
  const n = fabrications.filter(f => f.lot?.startsWith(prefix)).map(f => +f.lot.slice(prefix.length) || 0);
  return prefix + (Math.max(0, ...n) + 1);
}

// Produits déjà fabriqués, le plus récent d'abord, avec leur durée de conservation habituelle
function houseProducts() {
  const map = new Map();
  for (const f of [...fabrications].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))) {
    const k = normName(f.nom);
    if (!map.has(k)) map.set(k, { nom: f.nom, code: f.code, days: daysBetween(f.date, f.dlc) });
  }
  return [...map.values()];
}

// Code-barres à imprimer pour un article : son étiquette maison (BA…) de préférence
function articleCode(nom) {
  const codes = Object.entries(produitsDict).filter(([, v]) => normName(nomOf(v)) === normName(nom)).map(([c]) => c);
  return codes.find(c => c.startsWith('BA')) || codes[0] || null;
}

// ── Onglet ──
async function renderMaison() {
  await loadFabrications();
  await loadCfStock();
  const again = houseProducts().slice(0, 8);
  document.getElementById('fab-again').innerHTML = again.length ? `
    <div class="recent-title">Refaire :</div>
    <div class="fab-again-grid">${again.map(p => `<button class="recent-btn" onclick="openFab(${jsArg(p.nom)})">${esc(p.nom)}<small>DLC J+${p.days}</small></button>`).join('')}</div>` : '';
  renderFabList();
}

function renderFabList() {
  const el = document.getElementById('fab-list');
  if (!el || !fabrications) return;
  const q = normName(document.getElementById('fab-search')?.value || '');
  const list = fabrications
    .filter(f => !q || normName(f.nom).includes(q) || normName(f.lot).includes(q))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  if (!list.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">🍖</div><div class="empty-text">${q ? 'Aucune fabrication trouvée' : 'Aucune fabrication enregistrée'}</div></div>`;
    return;
  }
  const byDay = {};
  list.forEach(f => (byDay[f.date] = byDay[f.date] || []).push(f));
  el.innerHTML = Object.entries(byDay).map(([date, items]) => `
    <div class="recent-title">Fabriqué le ${formatDate(date)}</div>
    <div class="entries-list">${items.map(fabCardHtml).join('')}</div>`).join('');
}

function fabCardHtml(f) {
  const cf = f.cfId && (cfStock || []).find(s => s.id === f.cfId);
  const lvl = cf ? dlcLevel(f.dlc) : 'ok';
  const status = cf ? `🧊 ${cf.qty} en chambre froide` : f.cfId ? '✓ Écoulé' : 'Pas rangé en chambre froide';
  return `<div class="entry-card fab-card lvl-${lvl}">
    <div class="entry-top">
      <div class="entry-name">${esc(f.nom)} <span class="fab-qty">×${f.qty}</span></div>
      <div class="fab-lot">Lot ${esc(f.lot)}</div>
    </div>
    <div class="fab-meta">
      <span class="fab-dlc">${cf ? dlcText(f.dlc) : `DLC ${formatDlcDisplay(f.dlc)}`}</span>
      <span>${status}</span>
    </div>
    <div class="fab-actions">
      <button class="btn-edit" onclick="reprintFab(${jsArg(f.id)})">🖨️ Étiquettes ×${cf ? cf.qty : f.qty}</button>
      <button class="btn-edit" onclick="deleteFab(${jsArg(f.id)})">🗑️</button>
    </div>
  </div>`;
}

function reprintFab(id) {
  const f = fabrications.find(x => x.id === id);
  if (!f) return;
  const cf = f.cfId && (cfStock || []).find(s => s.id === f.cfId);
  printLotLabels(f.code, f.nom, f.dlc, null, cf ? cf.qty : f.qty, { fab: f.date, lot: f.lot });
}

async function deleteFab(id) {
  const f = fabrications.find(x => x.id === id);
  if (!f) return;
  const cf = f.cfId && (await loadCfStock()).find(s => s.id === f.cfId);
  if (!confirm(`Supprimer la fabrication « ${f.nom} » (lot ${f.lot}) ?${cf ? `\nLes ${cf.qty} restant${cf.qty > 1 ? 's' : ''} en chambre froide seront aussi retirés.` : ''}`)) return;
  fabrications = fabrications.filter(x => x.id !== id);
  await saveFabrications();
  if (cf) { cfStock = cfStock.filter(s => s.id !== cf.id); await saveCfStock(); }
  showToast('Fabrication supprimée', 'success');
  renderMaison();
}

// ── Fenêtre « Nouvelle fabrication » ──
const fabOpen = () => document.getElementById('fab-modal')?.style.display === 'flex';

// nom : produit déjà fabriqué (bouton « Refaire ») → on passe directement au formulaire
async function openFab(nom = null) {
  await loadFabrications();
  fab = null;
  fabPendingCode = null;
  document.getElementById('fab-modal').style.display = 'flex';
  if (nom) {
    const code = articleCode(nom) || houseProducts().find(p => normName(p.nom) === normName(nom))?.code;
    if (code) return fabChoose(code);
  }
  renderFabSearch();
}

function closeFab() {
  document.getElementById('fab-modal').style.display = 'none';
  fab = null;
  fabPendingCode = null;
  document.activeElement?.blur();
}

function renderFabSearch() {
  document.getElementById('fab-body').innerHTML = `
    <div style="padding:10px 16px;">
      <input type="text" id="fab-search-input" class="name-input" autocomplete="off" style="width:100%;"
             placeholder="🔍 Chercher un produit, ou taper le nom d'un nouveau…"
             oninput="renderFabChoices()" onkeydown="if(event.key==='Enter') fabEnter()">
    </div>
    <div class="cf-add-hint" id="fab-hint">📡 Tu peux aussi scanner l'étiquette du produit.</div>
    <div id="fab-choices"></div>`;
  renderFabChoices();
}

// Produits déjà fabriqués en premier, puis les autres articles (un par nom)
function fabMatches(q) {
  const nq = normName(q);
  const house = houseProducts().filter(p => !nq || normName(p.nom).includes(nq));
  const seen = new Set(house.map(p => normName(p.nom)));
  const others = [];
  for (const [code, v] of Object.entries(produitsDict)) {
    const n = nomOf(v) || code;
    const k = normName(n);
    if (seen.has(k) || (nq && !k.includes(nq) && code.toLowerCase() !== q.trim().toLowerCase())) continue;
    seen.add(k);
    others.push({ nom: n, code: articleCode(n) || code });
  }
  others.sort((a, b) => (b.code.startsWith('BA') - a.code.startsWith('BA')) || a.nom.localeCompare(b.nom, 'fr'));
  return { house, others };
}

function renderFabChoices() {
  const q = (document.getElementById('fab-search-input')?.value || '').trim();
  const { house, others } = fabMatches(q);
  const exact = [...house, ...others].some(a => normName(a.nom) === normName(q));
  const item = a => `<div class="cf-add-item" onclick="fabChoose(${jsArg(a.code)})">
      <span>${a.code.startsWith('BA') ? '🏷️' : '📦'} ${esc(a.nom)}</span><small>${a.days != null ? `DLC J+${a.days}` : esc(a.code)}</small></div>`;
  document.getElementById('fab-choices').innerHTML =
    (q && !exact ? `<div class="cf-add-item create" onclick="fabCreate()">➕ Nouveau produit maison « ${esc(q)} »
        <small>${fabPendingCode ? esc(fabPendingCode) : 'nouvelle étiquette'}</small></div>` : '')
    + (house.length ? `<div class="cf-add-hint">Déjà fabriqués :</div>${house.map(item).join('')}` : '')
    + (others.length ? `<div class="cf-add-hint">Autres articles :</div>${others.slice(0, 100).map(item).join('')}` : '')
    + (!q && !house.length && !others.length ? '<div class="cf-add-hint">Tape le nom du produit pour le créer.</div>' : '');
}

function fabEnter() {
  const q = document.getElementById('fab-search-input').value.trim();
  if (!q) return;
  const { house, others } = fabMatches(q);
  const all = [...house, ...others];
  const exact = all.find(a => normName(a.nom) === normName(q) || a.code === q);
  if (exact) fabChoose(exact.code);
  else if (/^\d{6,}$/.test(q)) { document.getElementById('fab-search-input').value = ''; fabScan(q); }
  else if (all.length === 1) fabChoose(all[0].code);
  else fabCreate();
}

function fabScan(code) {
  if (navigator.vibrate) navigator.vibrate(80);
  if (fab) { showToast("Termine d'abord cette fabrication", 'error'); return; }
  if (produitsDict[code]) { fabChoose(code); return; }
  fabPendingCode = code;
  document.getElementById('fab-hint').innerHTML = `📡 Code <strong>${esc(code)}</strong> inconnu — appuie sur le produit s'il existe déjà (le code lui sera ajouté), sinon tape son nom.`;
  document.getElementById('fab-search-input').focus();
  renderFabChoices();
}

async function fabCreate() {
  const nom = document.getElementById('fab-search-input').value.trim();
  if (!nom) { showToast('Entre un nom', 'error'); return; }
  const code = fabPendingCode || generateCode(nom);
  await addCodeToArticle(code, nom);
  fabPendingCode = null;
  await fabChoose(code, true);
}

async function fabChoose(code, isNew = false) {
  document.activeElement?.blur();
  if (fabPendingCode && !isNew) {
    const pending = fabPendingCode;
    fabPendingCode = null;
    await addCodeToArticle(pending, nameOfCode(code));
    code = pending;
  }
  const nom = nameOfCode(code) || code;
  const date = localDateStr(new Date());
  const known = houseProducts().find(p => normName(p.nom) === normName(nom));
  const f = { code, nom, isNew, date, dlc: known ? addDays(date, known.days) : null, qty: 1, toCf: true };
  fab = f;
  // Premier lot de ce produit : on demande la DLC ; ensuite on reprend la même durée
  if (!f.dlc) {
    const dlc = await pickDlc('DLC du lot', esc(nom), { from: date, quick: FAB_QUICK });
    if (fab !== f) return;
    if (!dlc) { fab = null; renderFabSearch(); return; }
    f.dlc = dlc;
  }
  renderFabForm();
}

function renderFabForm() {
  const f = fab;
  const today = localDateStr(new Date());
  document.getElementById('fab-body').innerHTML = `
    <div class="cf-add-form">
      <div>
        <div class="result-name">${esc(f.nom)}</div>
        <div style="font-family:monospace;font-size:12px;color:var(--text-dim);">${esc(f.code)}${f.isNew ? ' · produit créé ✓' : ''}</div>
      </div>
      <div class="cf-add-row">
        <span>🍖 Fabriqué le : <strong>${f.date === today ? "aujourd'hui" : formatDlcDisplay(f.date)}</strong></span>
        <button class="btn-edit" onclick="fabChangeDate()">Changer</button>
      </div>
      <div class="cf-add-row">
        <span>📅 DLC : <strong>${formatDlcDisplay(f.dlc)}</strong> <small style="color:var(--text-dim)">(J+${daysBetween(f.date, f.dlc)})</small></span>
        <button class="btn-edit" onclick="fabChangeDlc()">Changer</button>
      </div>
      <div class="cf-add-row">
        <span>Quantité (pièces / barquettes)</span>
        <div class="qty-stepper">
          <button onclick="fabStep(-1)">−</button>
          <span class="qty-value" id="fab-qty">${f.qty}</span>
          <button onclick="fabStep(1)">+</button>
        </div>
      </div>
      <label class="cf-add-row fab-check">
        <span>🧊 Ranger en chambre froide</span>
        <input type="checkbox" id="fab-to-cf" ${f.toCf ? 'checked' : ''} onchange="fab.toCf=this.checked">
      </label>
      <div class="cf-add-row" style="color:var(--text-dim);font-size:13px;">N° de lot : ${esc(nextLotNumber(f.date))}</div>
      <button class="btn-save" id="fab-confirm" onclick="fabConfirm(true)">✅ Enregistrer + 🖨️ imprimer <span id="fab-print-n">${f.qty > 1 ? `les ${f.qty} étiquettes` : "l'étiquette"}</span></button>
      <button class="btn-edit" id="fab-confirm-noprint" onclick="fabConfirm(false)">Enregistrer sans imprimer</button>
      <button class="btn-edit" onclick="fab=null;renderFabSearch()">← Choisir un autre produit</button>
    </div>`;
}

// Changer la date de fabrication garde la même durée de conservation
async function fabChangeDate() {
  const f = fab;
  const d = await pickPastDate('Date de fabrication', esc(f.nom), f.date);
  if (!d || fab !== f) return;
  f.dlc = addDays(d, daysBetween(f.date, f.dlc));
  f.date = d;
  renderFabForm();
}

async function fabChangeDlc() {
  const f = fab;
  const dlc = await pickDlc('DLC du lot', esc(f.nom), { from: f.date, quick: FAB_QUICK, value: f.dlc });
  if (!dlc || fab !== f) return;
  f.dlc = dlc;
  renderFabForm();
}

function fabStep(delta) {
  fab.qty = Math.max(1, fab.qty + delta);
  document.getElementById('fab-qty').textContent = fab.qty;
  document.getElementById('fab-print-n').textContent = fab.qty > 1 ? `les ${fab.qty} étiquettes` : "l'étiquette";
}

async function fabConfirm(print) {
  const f = fab;
  if (!f || !f.dlc) return;
  closeFab();
  await loadFabrications();
  const lot = nextLotNumber(f.date);
  let cfId = null;
  if (f.toCf) {
    // Chaque fabrication est son propre lot en chambre froide (jamais regroupée avec une autre)
    const stock = await loadCfStock();
    cfId = newCfId();
    stock.push({ id: cfId, nom: f.nom, dlc: f.dlc, qty: f.qty, supplier: `Fabrication maison · lot ${lot}`,
                 codeFacture: f.code, codePhysique: f.code, dateEntree: f.date, lotFab: lot });
    await saveCfStock();
  }
  fabrications.push({ id: 'fab_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), lot,
                      code: f.code, nom: f.nom, date: f.date, dlc: f.dlc, qty: f.qty, cfId, createdAt: new Date().toISOString() });
  await saveFabrications();
  showToast(`${f.nom} — lot ${lot} enregistré ✓`, 'success');
  renderMaison();
  if (print) printLotLabels(f.code, f.nom, f.dlc, null, f.qty, { fab: f.date, lot });
}
