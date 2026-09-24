// ════════════════════════════════════════
// ARTICLES — dictionnaire unifié (scans, étiquettes, chambre froide)
// ════════════════════════════════════════
let produitsDict = {};   // { code: nom } — produits.json (scans + étiquettes)
let cfStock = [];        // chambre-froide.json
let cfMapping = {};      // cf-mapping.json (liens code physique <-> code facture)
let currentFilter = 'all';
let editingArticle = null;
let linkAvailable = [];
let linkTargetId = null;

const jsArg = v => esc(JSON.stringify(v));

// Un « article facture » regroupe les lots de même code facture.
// Les lots ajoutés à la main n'ont pas de code facture : chacun reste un article à part.
const lotKey = item => item.codeFacture ? 'f_' + item.codeFacture : 'm_' + item.id;
const isLotOf = (item, article) => article.lotKeys && lotKey(item) === article.id;

function buildUnifiedList() {
  const items = [];

  // Articles depuis produits.json (scan manuel ou étiquette maison)
  for (const [code, nom] of Object.entries(produitsDict)) {
    const isLabel = code.startsWith('BA');
    items.push({
      id: 'p_' + code,
      kind: 'produit',
      nom: typeof nom === 'object' ? (nom.nom || code) : nom,
      codeFacture: null,
      codePhysique: code,
      source: isLabel ? 'etiquette' : 'manuel'
    });
  }

  // Articles depuis chambre-froide.json (facture)
  // On dédoublonne par codeFacture (plusieurs lots possibles avec DLC différentes)
  const seen = new Set();
  for (const item of cfStock) {
    if (seen.has(lotKey(item))) continue;
    seen.add(lotKey(item));
    items.push({
      id: lotKey(item),
      lotKeys: true,
      kind: 'facture',
      nom: item.nom,
      codeFacture: item.codeFacture,
      codePhysique: item.codePhysique || cfMapping[item.codeFacture] || null,
      source: 'facture',
      supplier: item.supplier
    });
  }

  return items;
}

function getLinkedArticles(article) {
  // Articles liés = ceux dont le code physique correspond au mapping de cet article
  const linked = [];
  const all = buildUnifiedList();
  if (article.codeFacture && cfMapping[article.codeFacture]) {
    const linkedCode = cfMapping[article.codeFacture];
    const found = all.find(a => a.codePhysique === linkedCode || a.codeFacture === linkedCode);
    if (found && found.id !== article.id) linked.push(found);
  }
  if (article.codePhysique && cfMapping[article.codePhysique]) {
    const linkedCode = cfMapping[article.codePhysique];
    const found = all.find(a => a.codeFacture === linkedCode || a.codePhysique === linkedCode);
    if (found && found.id !== article.id && !linked.find(l => l.id === found.id)) linked.push(found);
  }
  return linked;
}

// ════════════════════════════════════════
// RENDU LISTE
// ════════════════════════════════════════
function setFilter(f) {
  currentFilter = f;
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.filter === f));
  renderList();
}

function renderList() {
  const el = document.getElementById('article-list-content');
  const query = document.getElementById('search-input').value.trim().toLowerCase();
  let items = buildUnifiedList();

  if (currentFilter === 'sanscode') {
    items = items.filter(a => !a.codePhysique);
  } else if (currentFilter !== 'all') {
    items = items.filter(a => a.source === currentFilter);
  }

  if (query) {
    items = items.filter(a =>
      a.nom.toLowerCase().includes(query) ||
      (a.codeFacture || '').toLowerCase().includes(query) ||
      (a.codePhysique || '').toLowerCase().includes(query)
    );
  }

  items.sort((a, b) => a.nom.localeCompare(b.nom));

  document.getElementById('stats-bar').textContent = `${items.length} article${items.length > 1 ? 's' : ''}`;

  if (!items.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">Aucun article trouvé</div></div>';
    return;
  }

  el.innerHTML = `<div class="article-list">${items.map(a => renderArticleCard(a)).join('')}</div>`;
}

function renderArticleCard(a) {
  const linked = getLinkedArticles(a);
  const sourceLabel = { manuel: '📡 Scan', facture: '🧊 ' + esc(a.supplier || 'Chambre froide'), etiquette: '🏷️ Étiquette' }[a.source];
  const sourceClass = { manuel: 'source-manuel', facture: 'source-facture', etiquette: 'source-etiquette' }[a.source];

  return `
    <div class="article-card ${linked.length ? 'linked' : ''}" onclick="openEditModal(${jsArg(a.id)})">
      <div class="article-top">
        <div class="article-name">${esc(a.nom)}</div>
        <div class="article-source ${sourceClass}">${sourceLabel}</div>
      </div>
      <div class="article-codes">
        ${a.codeFacture ? `<span class="code-tag">📄 ${esc(a.codeFacture)}</span>` : ''}
        ${a.codePhysique
          ? `<span class="code-tag">🏷️ ${esc(a.codePhysique)}</span>`
          : '<span class="code-tag empty">⚠️ Sans code physique</span>'}
      </div>
      ${linked.length ? `<div class="linked-badge">🔗 Lié à ${linked.length} article${linked.length > 1 ? 's' : ''}</div>` : ''}
    </div>`;
}

// ════════════════════════════════════════
// MODAL ÉDITION
// ════════════════════════════════════════
function openEditModal(id) {
  const all = buildUnifiedList();
  const article = all.find(a => a.id === id);
  if (!article) return;
  editingArticle = article;

  document.getElementById('modal-title').textContent = article.nom;
  document.getElementById('modal-subtitle').textContent =
    article.source === 'facture' ? `Importé via facture${article.supplier ? ' — ' + article.supplier : ''}`
    : article.source === 'etiquette' ? 'Étiquette créée dans l\'app'
    : 'Ajouté via scan manuel';

  document.getElementById('edit-nom').value = article.nom;
  document.getElementById('edit-code-facture').value = article.codeFacture || '';
  document.getElementById('edit-code-physique').value = article.codePhysique || '';

  renderLinkedList(article);
  renderLinkTargetSelect(article);

  document.getElementById('edit-modal').classList.add('visible');
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.remove('visible');
  editingArticle = null;
}

function renderLinkedList(article) {
  const linked = getLinkedArticles(article);
  const el = document.getElementById('linked-list');
  if (!linked.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text-dim);">Aucun article lié pour le moment.</div>';
    return;
  }
  el.innerHTML = linked.map(l => `
    <div class="linked-item">
      <div>
        <div class="linked-item-name">${esc(l.nom)}</div>
        <div class="linked-item-code">${esc(l.codeFacture || l.codePhysique)}</div>
      </div>
      <button class="btn-unlink" onclick="unlinkArticle(${jsArg(l.id)})">Délier ✕</button>
    </div>`).join('');
}

function renderLinkTargetSelect(article) {
  const all = buildUnifiedList().filter(a => a.id !== article.id);
  const linkedIds = getLinkedArticles(article).map(l => l.id);
  linkAvailable = all.filter(a => !linkedIds.includes(a.id));
  linkTargetId = null;
  const input = document.getElementById('link-search-input');
  if (input) input.value = '';
  renderLinkDropdown('');
}

function filterLinkSearch(q) {
  linkTargetId = null;
  renderLinkDropdown(q);
  const dd = document.getElementById('link-dropdown');
  if (dd) dd.classList.add('open');
}

function renderLinkDropdown(q) {
  const dropdown = document.getElementById('link-dropdown');
  if (!dropdown) return;
  const filtered = q.trim()
    ? linkAvailable.filter(a =>
        a.nom.toLowerCase().includes(q.toLowerCase()) ||
        (a.codeFacture || a.codePhysique || '').toLowerCase().includes(q.toLowerCase()))
    : linkAvailable;
  if (!filtered.length) {
    dropdown.innerHTML = '<div style="padding:10px 12px;font-size:13px;color:var(--text-dim);">Aucun article trouvé</div>';
    return;
  }
  dropdown.innerHTML = filtered.slice(0, 60).map(a => {
    const code = a.codeFacture || a.codePhysique || '';
    return `<div class="link-dropdown-item${a.id === linkTargetId ? ' selected' : ''}"
              onmousedown="selectLinkTarget(${jsArg(a.id)}, ${jsArg(a.nom)}, ${jsArg(code)})">
              <div>${esc(a.nom)}</div>
              <div class="item-code">${esc(code)}</div>
            </div>`;
  }).join('');
}

function selectLinkTarget(id, nom, code) {
  linkTargetId = id;
  const input = document.getElementById('link-search-input');
  if (input) input.value = `${nom}${code ? ' (' + code + ')' : ''}`;
  const dd = document.getElementById('link-dropdown');
  if (dd) dd.classList.remove('open');
}

function showLinkDropdown() {
  const q = document.getElementById('link-search-input')?.value || '';
  renderLinkDropdown(q);
  const dd = document.getElementById('link-dropdown');
  if (dd) dd.classList.add('open');
}

function hideLinkDropdown() {
  setTimeout(() => {
    const dd = document.getElementById('link-dropdown');
    if (dd) dd.classList.remove('open');
  }, 160);
}

// Un renommage se propage dans tout l'historique déjà enregistré :
// articles est la source de vérité unique pour les noms.
async function propagateRenameToHistory(codes, newNom) {
  const codeSet = new Set(codes.filter(Boolean));
  if (!codeSet.size) return;
  for (const d of await Store.listDays()) {
    const entries = await Store.loadDay(d);
    let changed = false;
    entries.forEach(e => { if (codeSet.has(e.code) && e.nom !== newNom) { e.nom = newNom; changed = true; } });
    if (changed) await Store.saveDay(d, entries);
  }
}

async function saveArticleEdit() {
  if (!editingArticle) return;
  const newNom = document.getElementById('edit-nom').value.trim();
  const newCodeFacture = document.getElementById('edit-code-facture').value.trim();
  const newCodePhysique = document.getElementById('edit-code-physique').value.trim();

  if (!newNom) { showToast('Le nom est requis', 'error'); return; }

  const btn = document.querySelector('.btn-modal-primary');
  const originalLabel = btn.textContent;
  btn.textContent = '⏳ Enregistrement…';
  btn.disabled = true;

  try {
    // Tous les codes connus de cet article, pour la propagation dans l'historique
    const allCodes = [editingArticle.codeFacture, editingArticle.codePhysique, newCodePhysique, newCodeFacture];

    if (editingArticle.kind === 'produit') {
      // Renomme dans produits.json
      const oldCode = editingArticle.codePhysique;
      if (newCodePhysique && newCodePhysique !== oldCode) {
        delete produitsDict[oldCode];
        produitsDict[newCodePhysique] = newNom;
      } else {
        produitsDict[oldCode] = newNom;
      }
      await Store.save('produits.json', produitsDict);
    } else {
      // Met à jour tous les lots de ce codeFacture dans chambre-froide.json
      cfStock.forEach(item => {
        if (isLotOf(item, editingArticle)) {
          item.nom = newNom;
          if (newCodePhysique) item.codePhysique = newCodePhysique;
        }
      });
      await Store.save('chambre-froide.json', cfStock);

      // Met à jour le mapping si le code physique a changé
      if (editingArticle.codeFacture && newCodePhysique && newCodePhysique !== editingArticle.codePhysique) {
        if (editingArticle.codePhysique) {
          delete cfMapping[editingArticle.codePhysique];
        }
        cfMapping[newCodePhysique] = editingArticle.codeFacture;
        cfMapping[editingArticle.codeFacture] = newCodePhysique;
        await Store.save('cf-mapping.json', cfMapping);
      }
    }

    // Propage le nouveau nom dans tout l'historique de traçabilité déjà enregistré
    await propagateRenameToHistory(allCodes, newNom);

    showToast('Article mis à jour partout ✓', 'success');
    closeEditModal();
    renderList();
  } catch (e) {
    showToast('Erreur de sauvegarde', 'error');
    console.error(e);
  } finally {
    btn.textContent = originalLabel;
    btn.disabled = false;
  }
}

async function deleteArticle() {
  if (!editingArticle) return;
  if (!confirm(`Supprimer "${editingArticle.nom}" ? Cette action est irréversible.`)) return;

  try {
    if (editingArticle.kind === 'produit') {
      delete produitsDict[editingArticle.codePhysique];
      await Store.save('produits.json', produitsDict);
    } else {
      cfStock = cfStock.filter(item => !isLotOf(item, editingArticle));
      await Store.save('chambre-froide.json', cfStock);
    }

    // Nettoie les liens du mapping qui pointaient vers cet article
    let mappingChanged = false;
    [editingArticle.codeFacture, editingArticle.codePhysique].filter(Boolean).forEach(code => {
      if (cfMapping[code]) {
        delete cfMapping[cfMapping[code]];
        delete cfMapping[code];
        mappingChanged = true;
      }
    });
    if (mappingChanged) await Store.save('cf-mapping.json', cfMapping);

    showToast('Article supprimé ✓', 'success');
    closeEditModal();
    renderList();
  } catch (e) {
    showToast('Erreur de suppression', 'error');
  }
}

// ════════════════════════════════════════
// LIER / DÉLIER
// ════════════════════════════════════════
async function addLink() {
  if (!editingArticle) return;
  const targetId = linkTargetId;
  if (!targetId) { showToast('Choisis un article dans la liste', 'error'); return; }

  const all = buildUnifiedList();
  const target = all.find(a => a.id === targetId);
  if (!target) return;

  // On lie via les codes : codeA <-> codeB dans cf-mapping.json
  const codeA = editingArticle.codeFacture || editingArticle.codePhysique;
  const codeB = target.codeFacture || target.codePhysique;
  if (!codeA || !codeB) { showToast('Code manquant pour créer le lien', 'error'); return; }

  cfMapping[codeA] = codeB;
  cfMapping[codeB] = codeA;

  try {
    await Store.save('cf-mapping.json', cfMapping);
    showToast(`Lié à "${target.nom}" ✓`, 'success');
    renderLinkedList(editingArticle);
    renderLinkTargetSelect(editingArticle);
    renderList();
  } catch (e) {
    showToast('Erreur de liaison', 'error');
  }
}

async function unlinkArticle(targetId) {
  if (!editingArticle) return;
  const all = buildUnifiedList();
  const target = all.find(a => a.id === targetId);
  if (!target) return;

  const codeA = editingArticle.codeFacture || editingArticle.codePhysique;
  const codeB = target.codeFacture || target.codePhysique;

  delete cfMapping[codeA];
  delete cfMapping[codeB];

  try {
    await Store.save('cf-mapping.json', cfMapping);
    showToast('Lien supprimé', 'success');
    renderLinkedList(editingArticle);
    renderLinkTargetSelect(editingArticle);
    renderList();
  } catch (e) {
    showToast('Erreur', 'error');
  }
}

// ════════════════════════════════════════
// FUSION D'ARTICLES
// ════════════════════════════════════════
let mergeTarget = null; // l'article choisi dans le select, à fusionner avec editingArticle

function openMergeConfirm() {
  if (!editingArticle) return;
  const targetId = linkTargetId;
  if (!targetId) { showToast('Choisis un article à fusionner', 'error'); return; }

  const all = buildUnifiedList();
  const target = all.find(a => a.id === targetId);
  if (!target) return;
  mergeTarget = target;

  // Règle de priorité : on garde le code physique le plus "réel" (un vrai EAN/code scanné,
  // pas un code facture interne), et le nom le plus complet entre les deux.
  const keepNom = editingArticle.nom.length >= target.nom.length ? editingArticle.nom : target.nom;
  const otherNom = keepNom === editingArticle.nom ? target.nom : editingArticle.nom;

  const finalCodeFacture = editingArticle.codeFacture || target.codeFacture;
  const finalCodePhysique = editingArticle.codePhysique || target.codePhysique;

  const el = document.getElementById('merge-preview');
  el.innerHTML = `
    <div class="merge-warning">⚠️ « ${esc(target.nom)} » sera supprimé et fusionné dans cet article. Les deux ne pourront plus être séparés.</div>
    <div class="merge-preview-card">
      <div class="merge-preview-row">
        <div class="merge-preview-label">Nom</div>
        <div class="merge-preview-values">
          ${keepNom !== otherNom ? `<span class="merge-preview-old">${esc(otherNom)}</span>` : ''}
          <span class="merge-preview-new">${esc(keepNom)}</span>
        </div>
      </div>
      <div class="merge-preview-row">
        <div class="merge-preview-label">Code facture</div>
        <div class="merge-preview-values">
          <span class="${finalCodeFacture ? 'merge-preview-same' : 'merge-preview-old'}">${esc(finalCodeFacture || '— aucun —')}</span>
        </div>
      </div>
      <div class="merge-preview-row">
        <div class="merge-preview-label">Code physique</div>
        <div class="merge-preview-values">
          <span class="${finalCodePhysique ? 'merge-preview-same' : 'merge-preview-old'}">${esc(finalCodePhysique || '— aucun —')}</span>
        </div>
      </div>
      <div class="merge-preview-row">
        <div class="merge-preview-label">Sources</div>
        <div class="merge-preview-values merge-preview-same">${editingArticle.source} + ${target.source}</div>
      </div>
    </div>`;

  document.getElementById('merge-confirm-modal').classList.add('visible');
}

function closeMergeConfirm() {
  document.getElementById('merge-confirm-modal').classList.remove('visible');
  mergeTarget = null;
}

async function confirmMerge() {
  if (!editingArticle || !mergeTarget) return;
  const a = editingArticle;
  const b = mergeTarget;

  const keepNom = a.nom.length >= b.nom.length ? a.nom : b.nom;
  const finalCodeFacture = a.codeFacture || b.codeFacture;
  const finalCodePhysique = a.codePhysique || b.codePhysique;

  try {
    // 1. Met à jour produits.json : un seul code physique pointe vers le nom retenu,
    //    on retire l'éventuel doublon de code physique de l'autre article.
    if (finalCodePhysique) {
      produitsDict[finalCodePhysique] = keepNom;
    }
    // Si l'article qu'on absorbe avait un AUTRE code physique différent, on le retire de produits.json
    // pour éviter qu'il reste une entrée orpheline avec l'ancien nom.
    [a.codePhysique, b.codePhysique].filter(c => c && c !== finalCodePhysique).forEach(c => {
      delete produitsDict[c];
    });
    await Store.save('produits.json', produitsDict);

    // 2. Fusionne dans chambre-froide.json : tous les lots des deux codeFacture deviennent
    //    un seul article avec le nom et le code physique retenus.
    let stockChanged = false;
    cfStock.forEach(item => {
      if (isLotOf(item, a) || isLotOf(item, b)) {
        item.nom = keepNom;
        item.codeFacture = finalCodeFacture;
        item.codePhysique = finalCodePhysique;
        stockChanged = true;
      }
    });
    if (stockChanged) await Store.save('chambre-froide.json', cfStock);

    // 3. Nettoie le mapping : retire les anciens liens devenus inutiles, le code physique final
    //    et le code facture final restent associés l'un à l'autre.
    [a.codeFacture, a.codePhysique, b.codeFacture, b.codePhysique].filter(Boolean).forEach(c => {
      delete cfMapping[c];
    });
    if (finalCodePhysique && finalCodeFacture && finalCodePhysique !== finalCodeFacture) {
      cfMapping[finalCodePhysique] = finalCodeFacture;
      cfMapping[finalCodeFacture] = finalCodePhysique;
    }
    await Store.save('cf-mapping.json', cfMapping);

    showToast('Articles fusionnés ✓', 'success');
    closeMergeConfirm();
    closeEditModal();
    renderList();
  } catch (e) {
    showToast('Erreur de fusion', 'error');
    console.error(e);
  }
}

// ════════════════════════════════════════
// TOAST
// ════════════════════════════════════════
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
  [produitsDict, cfStock, cfMapping] = await Promise.all([
    Store.load('produits.json').then(d => d || {}),
    Store.load('chambre-froide.json').then(d => d || []),
    Store.load('cf-mapping.json').then(d => d || {}),
  ]);
  renderList();
  // Ici, scanner un produit sert à le retrouver dans la liste
  ScanCapture.start(code => {
    const input = document.getElementById('search-input');
    input.value = code;
    setFilter('all');
    if (navigator.vibrate) navigator.vibrate(80);
  });
});
