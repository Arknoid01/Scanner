// ════════════════════════════════════════
// CHAMBRE FROIDE — stock, ajout manuel, liaison des codes
// ════════════════════════════════════════
let stock = [];     // [{id, nom, dlc, qty, supplier, codeFacture, codePhysique, dateEntree}]
let mapping = {};   // { codePhysique: codeFacture } et { codeFacture: codePhysique }
let manualDlc = null;

const jsArg = v => esc(JSON.stringify(v));
const saveStock = () => Store.save('chambre-froide.json', stock);

// ════════════════════════════════════════
// STOCK
// ════════════════════════════════════════
function daysUntil(dlcStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.floor((new Date(dlcStr + 'T00:00:00') - today) / 86400000);
}

function dlcClass(dlcStr) {
  if (!dlcStr) return 'lot-ok';
  const diff = daysUntil(dlcStr);
  if (diff < 0) return 'lot-expired';
  if (diff <= 1) return 'lot-danger';
  if (diff <= 3) return 'lot-warn';
  return 'lot-ok';
}

function dlcLabel(dlcStr) {
  if (!dlcStr) return 'Sans DLC';
  const diff = daysUntil(dlcStr);
  const fmt = new Date(dlcStr + 'T00:00:00').toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
  if (diff < 0) return `⚠️ DLC ${fmt} (${Math.abs(diff)}j dépassée)`;
  if (diff === 0) return `🔴 DLC aujourd'hui`;
  if (diff === 1) return `🔴 DLC demain`;
  if (diff <= 3) return `🟡 DLC ${fmt} (${diff}j)`;
  return `🟢 DLC ${fmt}`;
}

// Tri de la liste (mémorisé sur la tablette)
const byDlc = (a, b) => (a.dlc || '9999-12-31').localeCompare(b.dlc || '9999-12-31');
const SORTS = {
  dlc: byDlc,
  nom: (a, b) => (a.nom || '').localeCompare(b.nom || '', 'fr') || byDlc(a, b),
  entree: (a, b) => (b.dateEntree || '').localeCompare(a.dateEntree || '') || byDlc(a, b),
};
let stockSort = (() => { try { return SORTS[localStorage.getItem('sb_cf_sort')] ? localStorage.getItem('sb_cf_sort') : 'dlc'; } catch { return 'dlc'; } })();

function setStockSort(key) {
  stockSort = key;
  try { localStorage.setItem('sb_cf_sort', key); } catch {}
  document.querySelectorAll('.sort-chip').forEach(c => c.classList.toggle('active', c.dataset.sort === key));
  renderStock();
}

// Sortir / jeter / congeler / étiquette : fiche du lot sur la page Scanner, qui gère l'historique et l'annulation
function openLot(id) { location.href = 'index.html#lot=' + encodeURIComponent(id); }

// Appui sur un lot : corriger sa DLC ou sa date d'entrée (erreur d'import…), ou aller le sortir
function openLotEdit(id) {
  const item = stock.find(i => i.id === id);
  if (!item) return;
  document.querySelector('.lot-edit-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'dlc-picker-overlay lot-edit-overlay';
  overlay.innerHTML = `
    <div class="dlc-picker">
      <div class="dlc-picker-title">${esc(item.nom)}</div>
      <div class="dlc-picker-sub">${item.qty} en stock${item.supplier ? ` · ${esc(item.supplier)}` : ''}</div>
      <div class="lot-edit-row">
        <span>📅 DLC : <strong>${item.dlc ? formatDlcDisplay(item.dlc) : 'aucune'}</strong></span>
        <button class="dlc-ok lot-edit-dlc">Modifier</button>
      </div>
      <div class="lot-edit-row">
        <span>📥 Entré le : <strong>${item.dateEntree ? formatDlcDisplay(item.dateEntree) : '?'}</strong></span>
        <button class="dlc-ok lot-edit-entree">Modifier</button>
      </div>
      <button class="btn-primary lot-edit-out">📤 Sortir, jeter ou congeler…</button>
      <button class="dlc-cancel">Fermer</button>
    </div>`;
  overlay.addEventListener('click', async (e) => {
    if (e.target.closest('.dlc-cancel') || e.target === overlay) return overlay.remove();
    if (e.target.closest('.lot-edit-out')) return openLot(id);
    if (e.target.closest('.lot-edit-dlc')) {
      const d = await pickDlc('Corriger la DLC', esc(item.nom), { allowPast: true, value: item.dlc });
      if (!d) return;
      item.dlc = d;
      await saveStock();
      renderStock();
      showToast('DLC corrigée ✓', 'success');
      openLotEdit(id);
    }
    if (e.target.closest('.lot-edit-entree')) {
      overlay.remove();
      await editDateEntree(id);
      openLotEdit(id);
    }
  });
  document.body.appendChild(overlay);
}

function renderStock() {
  const el = document.getElementById('stock-content');
  if (!stock.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">🧊</div><div class="empty-text">Chambre froide vide<br><span style="font-size:13px;">Réceptionne depuis la page Scanner, ou ajoute à la main</span></div></div>';
    return;
  }
  const q = (document.getElementById('stock-search')?.value || '').trim().toLowerCase();
  const sorted = stock.filter(i => !q || (i.nom || '').toLowerCase().includes(q)).sort(SORTS[stockSort]);
  const reds = sorted.filter(i => ['lot-danger', 'lot-expired'].includes(dlcClass(i.dlc)));
  const yellows = sorted.filter(i => dlcClass(i.dlc) === 'lot-warn');
  const sansDate = stock.filter(i => !i.dateEntree).length;

  el.innerHTML = `
    <div class="stock-header">
      <div class="stock-count">${q ? `${sorted.length} sur ` : ''}${stock.length} article${stock.length > 1 ? 's' : ''}</div>
      <div class="stock-alerts">
        ${reds.length ? `<div class="alert-badge red">🔴 ${reds.length}</div>` : ''}
        ${yellows.length ? `<div class="alert-badge yellow">🟡 ${yellows.length}</div>` : ''}
      </div>
    </div>
    ${sansDate ? `<button class="btn-secondary" style="margin-bottom:8px;" onclick="fillMissingDates()">📥 ${sansDate} lot${sansDate > 1 ? 's' : ''} sans date d'entrée — leur en donner une</button>` : ''}
    ${!sorted.length ? '<div class="empty-state"><div class="empty-text">Aucun lot ne correspond</div></div>' : ''}
    <div class="stock-list">
      ${sorted.map(item => `
        <div class="stock-item ${dlcClass(item.dlc)}">
          <div class="stock-item-info" onclick="openLotEdit(${jsArg(item.id)})">
            <div class="stock-item-name">${esc(item.nom)}</div>
            <div class="stock-item-meta">
              <span class="stock-item-dlc">${dlcLabel(item.dlc)}</span>
              <button class="stock-item-entree ${item.dateEntree ? '' : 'missing'}" onclick="event.stopPropagation();editDateEntree(${jsArg(item.id)})">📥 ${item.dateEntree ? `Entré le ${formatDlcDisplay(item.dateEntree)}` : "Date d'entrée ?"}</button>
              ${item.supplier ? `<span class="stock-item-supplier">${esc(item.supplier)}</span>` : ''}
            </div>
          </div>
          <div class="stock-item-qty">×${item.qty}</div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            <button class="btn-out btn-add" onclick="addOneItem(${jsArg(item.id)})">+</button>
            <button class="btn-out" onclick="removeOneItem(${jsArg(item.id)})">−</button>
          </div>
        </div>`).join('')}
    </div>`;
}

// Date d'entrée d'un lot (les lots importés de l'ancienne version n'en ont pas toujours)
async function editDateEntree(id) {
  const item = stock.find(i => i.id === id);
  if (!item) return;
  const d = await pickPastDate("Date d'entrée", esc(item.nom), item.dateEntree);
  if (!d) return;
  item.dateEntree = d;
  await saveStock();
  renderStock();
  showToast("Date d'entrée enregistrée ✓", 'success');
}

async function fillMissingDates() {
  const missing = stock.filter(i => !i.dateEntree);
  if (!missing.length) return;
  const d = await pickPastDate("Date d'entrée", `Appliquée aux ${missing.length} lot(s) qui n'en ont pas`);
  if (!d) return;
  missing.forEach(i => { i.dateEntree = d; });
  await saveStock();
  renderStock();
  showToast("Dates d'entrée enregistrées ✓", 'success');
}

async function addOneItem(id) {
  const item = stock.find(i => i.id === id);
  if (!item) return;
  item.qty++;
  await saveStock();
  renderStock();
  showToast('Quantité ajustée ✓', 'success');
}

async function removeOneItem(id) {
  const idx = stock.findIndex(i => i.id === id);
  if (idx === -1) return;
  stock[idx].qty--;
  if (stock[idx].qty <= 0) stock.splice(idx, 1);
  await saveStock();
  renderStock();
  showToast('Quantité ajustée ✓', 'success');
}

// ════════════════════════════════════════
// AJOUT MANUEL
// ════════════════════════════════════════
async function chooseManualDlc() {
  const dlc = await pickDlc('DLC du lot', document.getElementById('manual-nom').value.trim());
  if (!dlc) return;
  manualDlc = dlc;
  document.getElementById('manual-dlc-btn').textContent = `📅 ${formatDlcDisplay(dlc)}`;
}

function stepQty(delta) {
  const input = document.getElementById('manual-qty');
  input.value = Math.max(1, (parseInt(input.value) || 1) + delta);
}

async function addManualItem() {
  const nom = document.getElementById('manual-nom').value.trim();
  const qty = parseInt(document.getElementById('manual-qty').value) || 1;
  const supplier = document.getElementById('manual-supplier').value.trim();
  if (!nom) { showToast('Entre un nom', 'error'); return; }

  stock.push({
    id: 'cf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    nom, dlc: manualDlc, qty, supplier,
    codeFacture: null, codePhysique: null, dateEntree: localDateStr(new Date())
  });
  await saveStock();
  renderStock();

  document.getElementById('manual-nom').value = '';
  document.getElementById('manual-qty').value = '1';
  document.getElementById('manual-supplier').value = '';
  document.getElementById('manual-dlc-btn').textContent = '📅 Choisir la DLC';
  manualDlc = null;
  showToast(`${nom} ajouté ✓`, 'success');
  switchTab('stock');
}

function fillSupplierList() {
  const names = [...new Set(stock.map(s => s.supplier).filter(Boolean))].sort();
  document.getElementById('supplier-list').innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');
}

// ════════════════════════════════════════
// LIAISON
// ════════════════════════════════════════
let liaisonProduits = {};

async function loadLiaison() {
  liaisonProduits = (await Store.load('produits.json')) || {};
  const sansCodes = stock.filter(item => !item.codePhysique && !(item.codeFacture && mapping[item.codeFacture]));
  const el = document.getElementById('liaison-content');
  if (!sansCodes.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">✅</div><div class="empty-text">Tous les articles sont déjà liés !</div></div>';
    return;
  }
  const options = Object.entries(liaisonProduits)
    .map(([code, nom]) => ({ code, nom: typeof nom === 'object' ? (nom.nom || code) : nom }))
    .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));

  el.innerHTML = `
    <div style="font-size:13px;color:var(--text-dim);">${sansCodes.length} article${sansCodes.length > 1 ? 's' : ''} à lier</div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      ${sansCodes.map((item, i) => `
        <div class="liaison-item" id="liaison-${i}">
          <div>
            <div class="liaison-facture">${esc(item.nom)}</div>
            <div class="liaison-facture-code">${esc(item.codeFacture || '—')} · ${esc(item.supplier || '')}</div>
          </div>
          <select class="input-field" id="liaison-select-${i}" style="font-size:14px;">
            <option value="">— Choisir le produit scanné —</option>
            ${options.map(o => `<option value="${esc(o.code)}">${esc(o.nom)} (${esc(o.code)})</option>`).join('')}
          </select>
          <button class="btn-confirm-liaison" onclick="confirmLiaison(${i}, ${jsArg(item.id)})">✓ Lier</button>
        </div>`).join('')}
    </div>`;
}

async function confirmLiaison(idx, itemId) {
  const codePhysique = document.getElementById(`liaison-select-${idx}`)?.value;
  if (!codePhysique) { showToast('Choisis un produit', 'error'); return; }
  const item = stock.find(s => s.id === itemId);
  if (!item) return;
  item.codePhysique = codePhysique;
  if (item.codeFacture) {
    mapping[codePhysique] = item.codeFacture;
    mapping[item.codeFacture] = codePhysique;
    await Store.save('cf-mapping.json', mapping);
  }
  await saveStock();
  const card = document.getElementById(`liaison-${idx}`);
  card.classList.add('confirmed');
  card.innerHTML += '<div style="color:var(--green);font-size:13px;font-weight:700;margin-top:4px;">✓ Lié !</div>';
  showToast('Lien créé ✓', 'success');
}

// ════════════════════════════════════════
// UI
// ════════════════════════════════════════
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${tab}`));
  if (tab === 'liaison') loadLiaison();
  if (tab === 'ajout') fillSupplierList();
}

let toastTimer;
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2500);
}

// ════════════════════════════════════════
// INIT
// ════════════════════════════════════════
window.addEventListener('load', async () => {
  [stock, mapping] = await Promise.all([
    Store.load('chambre-froide.json').then(d => d || []),
    Store.load('cf-mapping.json').then(d => d || {}),
  ]);
  setStockSort(stockSort);
  // Un scan ici = une sortie, traitée par la page Scanner
  ScanCapture.start(code => { location.href = 'index.html#scan=' + encodeURIComponent(code); });
});
