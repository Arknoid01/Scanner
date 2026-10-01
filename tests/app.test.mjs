// Tests des parcours principaux dans un navigateur simulé (jsdom), stockage = localStorage.
// La douchette est simulée en tapant les caractères puis Entrée, comme le fait l'appareil.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole, requestInterceptor } from 'jsdom';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import JSZip from 'jszip';

const WWW = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'www');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// localStorage n'existe pas sur file:// dans jsdom : on sert www/ sous http://app.local/
const localFiles = requestInterceptor((request) => {
  const u = new URL(request.url);
  if (u.hostname !== 'app.local') return new Response('bloqué', { status: 403 });
  const type = u.pathname.endsWith('.css') ? 'text/css' : 'text/javascript';
  return new Response(readFileSync(path.join(WWW, decodeURIComponent(u.pathname))), { headers: { 'content-type': type } });
});

// Charge une page de l'app ; `storage` permet de garder les données d'une page à l'autre
async function openPage(file, storage = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));
  vc.on('error', e => errors.push(String(e)));
  const html = readFileSync(path.join(WWW, file), 'utf8');
  const dom = new JSDOM(html, {
    url: `http://app.local/${file}`,
    runScripts: 'dangerously',
    resources: { interceptors: [localFiles] },
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      // jsdom n'exécute pas le « setImmediate » maison de JSZip : on lui en fournit un
      win.setImmediate = (f, ...a) => win.setTimeout(f, 0, ...a);
      for (const [k, v] of Object.entries(storage)) win.localStorage.setItem(k, v);
      win.confirm = () => true;
      win.alert = () => {};
      win.navigator.vibrate = () => true;
    },
  });
  await new Promise(r => dom.window.addEventListener('load', r));
  await sleep(50);
  return { dom, win: dom.window, doc: dom.window.document, errors };
}

function dumpStorage(win) {
  const out = {};
  for (let i = 0; i < win.localStorage.length; i++) {
    const k = win.localStorage.key(i);
    out[k] = win.localStorage.getItem(k);
  }
  return out;
}

async function scan(win, code) {
  for (const ch of code) win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: ch, bubbles: true }));
  win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(80);
}

const read = (win, name) => JSON.parse(win.localStorage.getItem('sbf:data/' + name) || 'null');
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Données de départ, au format de l'ancien dossier Drive
const SEED = {
  'produits.json': { '3700001': 'Saucisson sec', 'BA12AB': 'Pâté maison' },
  'chambre-froide.json': [
    { id: 'cf_1', nom: 'Faux-filet', dlc: '2099-01-10', qty: 2, supplier: 'TRADIVAL', codeFacture: 'F100', codePhysique: '2000100', dateEntree: '2026-09-01' },
    { id: 'cf_2', nom: 'Faux-filet', dlc: '2099-01-05', qty: 1, supplier: 'TRADIVAL', codeFacture: 'F100', codePhysique: '2000100', dateEntree: '2026-09-01' },
    { id: 'cf_3', nom: 'Jambon cru', dlc: '2099-02-01', qty: 3, supplier: 'Chazal', codeFacture: 'J55', codePhysique: null, dateEntree: '2026-09-01' },
  ],
  'congelateur.json': [{ nom: 'Os à moelle', code: '', date: '2026-09-01' }],
  'cf-mapping.json': {},
};

async function driveZip() {
  const zip = new JSZip();
  const root = zip.folder('Scanner Boucherie');
  for (const [n, d] of Object.entries(SEED)) root.file(n, JSON.stringify(d));
  root.file('produits (1).json', '{}'); // doublon Drive plus petit : doit être ignoré
  root.folder('2026-09-20').file('2026-09-20.json', JSON.stringify([{ heure: '09:12', code: '3700001', nom: 'Saucisson sec' }]));
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function seededStorage() {
  const { win } = await openPage('index.html');
  const buf = await driveZip();
  const found = await win.eval("Store").parseZips([new win.Uint8Array(buf)]);
  await win.eval("Store").applyImport(found);
  return dumpStorage(win);
}

test('aucune ressource réseau dans l\'app (tout est local)', () => {
  const offenders = [];
  const walk = dir => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { if (f.name !== 'vendor') walk(p); continue; }
      const txt = readFileSync(p, 'utf8');
      if (/https?:\/\/(?!www\.w3\.org)/.test(txt)) offenders.push(p);
    }
  };
  walk(WWW);
  assert.deepEqual(offenders, []);
});

test('import du ZIP Drive : fichiers principaux + historique, doublon ignoré', async () => {
  const { win } = await openPage('index.html');
  const found = await win.eval("Store").parseZips([new win.Uint8Array(await driveZip())]);
  const s = win.eval("Store").summarize(found);
  assert.equal(s.produits, 2);
  assert.equal(s.chambreFroide, 3);
  assert.equal(s.jours, 1);
  await win.eval("Store").applyImport(found);
  assert.equal(read(win, 'produits.json')['3700001'], 'Saucisson sec');
  assert.deepEqual([...await win.eval("Store").listDays()], ['2026-09-20']);
});

test('sortie : produit en chambre froide → retiré (DLC la plus proche) + historique, sans clic', async () => {
  const { win, doc, errors } = await openPage('index.html', await seededStorage());
  await scan(win, '2000100');
  const stock = read(win, 'chambre-froide.json');
  assert.equal(stock.find(s => s.id === 'cf_2'), undefined, 'le lot à DLC la plus proche est sorti en premier');
  assert.equal(stock.find(s => s.id === 'cf_1').qty, 2);
  const hist = read(win, `jours/${today()}.json`);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].nom, 'Faux-filet');
  assert.equal(hist[0].action, 'sortie');
  assert.match(doc.getElementById('result-area').textContent, /Sorti de la chambre froide/);
  assert.deepEqual(errors, []);
});

test('annuler : remet le lot et efface la ligne d\'historique', async () => {
  const { win, doc } = await openPage('index.html', await seededStorage());
  await scan(win, '2000100');
  doc.querySelector('.btn-undo').click();
  await sleep(80);
  const stock = read(win, 'chambre-froide.json');
  assert.equal(stock.find(s => s.id === 'cf_2').qty, 1);
  assert.equal(read(win, `jours/${today()}.json`).length, 0);
});

test('produit connu hors chambre froide : noté dans l\'historique directement', async () => {
  const { win } = await openPage('index.html', await seededStorage());
  await scan(win, '3700001');
  const hist = read(win, `jours/${today()}.json`);
  assert.equal(hist[0].nom, 'Saucisson sec');
});

test('produit inconnu : on tape le nom + Entrée → enregistré et reconnu la fois suivante', async () => {
  const { win, doc } = await openPage('index.html', await seededStorage());
  await scan(win, '999888');
  const input = doc.getElementById('name-input');
  assert.ok(input, 'champ nom affiché');
  input.value = 'Rillettes';
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(80);
  assert.equal(read(win, 'produits.json')['999888'], 'Rillettes');
  assert.equal(read(win, `jours/${today()}.json`)[0].nom, 'Rillettes');
});

test('produit inconnu relié en 1 appui à un article sans code de la chambre froide', async () => {
  const { win, doc } = await openPage('index.html', await seededStorage());
  await scan(win, '4400');
  await sleep(50);
  const btn = [...doc.querySelectorAll('#cf-link-area button')].find(b => b.textContent.includes('Jambon cru'));
  assert.ok(btn);
  btn.click();
  await sleep(80);
  const jambon = read(win, 'chambre-froide.json').find(s => s.id === 'cf_3');
  assert.equal(jambon.codePhysique, '4400');
  assert.equal(jambon.qty, 2, 'sorti du stock');
  assert.equal(read(win, 'cf-mapping.json')['4400'], 'J55');
});

test('ouverture partielle : historique noté, stock inchangé', async () => {
  const { win, doc } = await openPage('index.html', await seededStorage());
  doc.querySelector('.mode-btn[data-mode="partiel"]').click();
  await sleep(30);
  await scan(win, '2000100');
  assert.equal(read(win, 'chambre-froide.json').find(s => s.id === 'cf_2').qty, 1);
  assert.equal(read(win, `jours/${today()}.json`)[0].action, 'ouverture');
});

test('réception viande : DLC choisie en 1 appui, poches scannées en rafale', async () => {
  const { win, doc } = await openPage('index.html', await seededStorage());
  doc.querySelector('.mode-btn[data-mode="viande"]').click();
  await sleep(30);
  const quick = doc.querySelector('.dlc-quick'); // J+3
  const dlc = quick.dataset.date;
  quick.click();
  await sleep(30);
  await scan(win, '3700001');
  await scan(win, '3700001');
  await scan(win, '3700001');
  const lots = read(win, 'chambre-froide.json').filter(s => s.codePhysique === '3700001');
  assert.equal(lots.length, 1);
  assert.equal(lots[0].qty, 3);
  assert.equal(lots[0].dlc, dlc);
});

test('pendant le choix de la DLC, un scan est ignoré', async () => {
  const { win, doc } = await openPage('index.html', await seededStorage());
  doc.querySelector('.mode-btn[data-mode="viande"]').click();
  await sleep(30);
  await scan(win, '2000100'); // sélecteur ouvert
  assert.equal(read(win, `jours/${today()}.json`), null);
  doc.querySelector('.dlc-cancel').click();
  await sleep(30);
  assert.ok(doc.querySelector('.mode-btn[data-mode="sortie"]').classList.contains('active'), 'annuler garde le mode Sortie');
});

test('réception DLC : DLC demandée à chaque scan puis rangé en chambre froide', async () => {
  const { win, doc } = await openPage('index.html', await seededStorage());
  doc.querySelector('.mode-btn[data-mode="dlc"]').click();
  await sleep(30);
  await scan(win, '3700001');
  const btn = doc.querySelectorAll('.dlc-quick')[2]; // J+7
  const dlc = btn.dataset.date;
  btn.click();
  await sleep(80);
  const lot = read(win, 'chambre-froide.json').find(s => s.codePhysique === '3700001');
  assert.equal(lot.dlc, dlc);
  assert.equal(lot.qty, 1);
});

test('un nom tapé au clavier dans un champ n\'est pas pris pour un scan', async () => {
  const { win, doc } = await openPage('index.html', await seededStorage());
  doc.querySelector('.tab[data-tab="labels"]').click();
  const input = doc.getElementById('label-name-input');
  input.focus();
  for (const ch of '123456') input.dispatchEvent(new win.KeyboardEvent('keydown', { key: ch, bubbles: true }));
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(50);
  assert.equal(read(win, `jours/${today()}.json`), null);
});

test('congélateur : un scan sur l\'onglet ajoute le produit', async () => {
  const { win, doc } = await openPage('index.html', await seededStorage());
  doc.querySelector('.tab[data-tab="freezer"]').click();
  await sleep(30);
  await scan(win, '3700001');
  const cong = read(win, 'congelateur.json');
  assert.equal(cong[0].nom, 'Saucisson sec');
  assert.equal(cong.length, 2);
});

test('historique : liste des jours et recherche', async () => {
  const { win, doc } = await openPage('index.html', await seededStorage());
  doc.querySelector('.tab[data-tab="history"]').click();
  await sleep(80);
  assert.equal(doc.querySelectorAll('.day-card').length, 1);
  doc.getElementById('search-input').value = 'sauc';
  win.handleSearch();
  assert.match(doc.getElementById('history-content').textContent, /1 résultat/);
});

test('étiquette : création enregistrée dans les produits', async () => {
  const { win, doc } = await openPage('index.html', await seededStorage());
  doc.querySelector('.tab[data-tab="labels"]').click();
  doc.getElementById('label-name-input').value = 'Terrine';
  await win.createLabel();
  assert.ok(Object.entries(read(win, 'produits.json')).some(([c, n]) => c.startsWith('BA') && n === 'Terrine'));
});

test('sauvegarde ZIP relisible par l\'import (aller-retour)', async () => {
  const { win } = await openPage('index.html', await seededStorage());
  const b64 = await win.eval("Store").exportZipBase64();
  const found = await win.eval("Store").parseZips([new win.Uint8Array(Buffer.from(b64, 'base64'))]);
  assert.equal(win.eval("Store").summarize(found).chambreFroide, 3);
  assert.equal(win.eval("Store").summarize(found).jours, 1);
});

test('chambre froide : stock affiché, ajout manuel avec DLC rapide', async () => {
  const { win, doc, errors } = await openPage('chambre-froide.html', await seededStorage());
  assert.equal(doc.querySelectorAll('.stock-item').length, 3);
  win.switchTab('ajout');
  doc.getElementById('manual-nom').value = 'Chorizo';
  doc.getElementById('manual-dlc-btn').click();
  await sleep(20);
  doc.querySelector('.dlc-quick').click();
  await sleep(20);
  await win.addManualItem();
  const lot = read(win, 'chambre-froide.json').find(s => s.nom === 'Chorizo');
  assert.ok(lot.dlc);
  assert.deepEqual(errors, []);
});

test('articles : les lots ajoutés à la main restent des articles distincts', async () => {
  const storage = await seededStorage();
  const stock = JSON.parse(storage['sbf:data/chambre-froide.json']);
  stock.push({ id: 'm1', nom: 'Boudin', qty: 1, codeFacture: null, codePhysique: null });
  stock.push({ id: 'm2', nom: 'Andouille', qty: 1, codeFacture: null, codePhysique: null });
  storage['sbf:data/chambre-froide.json'] = JSON.stringify(stock);
  const { win, doc, errors } = await openPage('articles.html', storage);
  const names = [...doc.querySelectorAll('.article-name')].map(e => e.textContent);
  assert.ok(names.includes('Boudin') && names.includes('Andouille'));
  // Renommer Boudin ne doit pas toucher Andouille
  win.openEditModal('m_m1');
  doc.getElementById('edit-nom').value = 'Boudin noir';
  await win.saveArticleEdit();
  const after = read(win, 'chambre-froide.json');
  assert.equal(after.find(s => s.id === 'm1').nom, 'Boudin noir');
  assert.equal(after.find(s => s.id === 'm2').nom, 'Andouille');
  assert.deepEqual(errors, []);
});

test('articles : un renommage se propage dans l\'historique', async () => {
  const { win, doc } = await openPage('articles.html', await seededStorage());
  win.openEditModal('p_3700001');
  doc.getElementById('edit-nom').value = 'Saucisson sec pur porc';
  await win.saveArticleEdit();
  assert.equal(read(win, 'jours/2026-09-20.json')[0].nom, 'Saucisson sec pur porc');
});

// ── Import JSON copié-collé, tuile « Mettre en chambre froide », sortie sans scan ──

test('import JSON collé : lots fusionnés dans la chambre froide, rien d\'écrasé', async () => {
  const { win, doc, errors } = await openPage('chambre-froide.html', await seededStorage());
  win.switchTab('ajout');
  [...doc.querySelectorAll('#page-ajout button')].find(b => b.textContent.includes('Importer un JSON')).click();
  assert.equal(doc.querySelector('.json-import-target').value, 'chambre-froide.json');
  assert.equal(doc.querySelector('.json-import-date').value, today(), 'date du jour proposée');
  doc.querySelector('.json-import-date').value = '2026-09-22';
  doc.querySelector('.json-import-text').value = JSON.stringify([
    { nom: 'Faux-filet', dlc: '2099-01-10', qty: 3, codeFacture: 'F100' },  // même lot → +3
    { nom: 'Rosette', dlc: '2099-03-01', qty: 2, supplier: 'Chazal' },       // nouveau lot
    { nom: 'Coppa', dlc: '2099-03-02', dateEntree: '2020-01-01' },           // date du JSON remplacée
  ]);
  doc.querySelector('.json-import-ok').click();
  await sleep(80);
  const stock = read(win, 'chambre-froide.json');
  assert.equal(stock.length, 5);
  assert.equal(stock.find(s => s.id === 'cf_1').qty, 5);
  const rosette = stock.find(s => s.nom === 'Rosette');
  assert.equal(rosette.qty, 2);
  assert.equal(rosette.dateEntree, '2026-09-22', 'date choisie appliquée aux nouveaux lots');
  assert.equal(stock.find(s => s.nom === 'Coppa').dateEntree, '2026-09-22');
  assert.equal(stock.find(s => s.id === 'cf_1').dateEntree, '2026-09-01', 'lots existants inchangés');
  assert.ok(rosette.id);
  assert.deepEqual(errors, []);
  win.close();
});

test('import JSON collé : JSON invalide ou mauvaise forme → message, rien n\'est écrit', async () => {
  const { win, doc } = await openPage('index.html', await seededStorage());
  const before = win.localStorage.getItem('sbf:data/chambre-froide.json');
  win.openJsonImport();
  doc.querySelector('.json-import-text').value = '[{ "nom": ';
  doc.querySelector('.json-import-ok').click();
  await sleep(30);
  assert.match(doc.querySelector('.json-import-error').textContent, /invalide/);
  doc.querySelector('.json-import-target').value = 'produits.json';
  doc.querySelector('.json-import-text').value = '[1, 2]';
  doc.querySelector('.json-import-ok').click();
  await sleep(30);
  assert.match(doc.querySelector('.json-import-error').textContent, /objet/);
  assert.equal(win.localStorage.getItem('sbf:data/chambre-froide.json'), before);
});

test('import JSON : recoller les mêmes lots (mêmes id) ne les double pas', async () => {
  const { win } = await openPage('index.html');
  const lots = [{ id: 'x1', nom: 'Boudin', dlc: '2099-01-01', qty: 2 }];
  const first = win.mergeJsonImport('chambre-froide.json', [], lots);
  const again = win.mergeJsonImport('chambre-froide.json', first.merged, lots);
  assert.equal(again.added, 0);
  assert.equal(again.merged.length, 1);
  assert.equal(again.merged[0].qty, 2);
  const prod = win.mergeJsonImport('produits.json', { a: 'A' }, { a: 'A2', b: 'B' });
  assert.deepEqual({ ...prod.merged }, { a: 'A2', b: 'B' });
  assert.equal(prod.added, 1);
});

test('tuile chambre froide : article créé (étiquette BA), rangé avec DLC + quantité, puis sorti au scan', async () => {
  const { win, doc, errors } = await openPage('index.html', await seededStorage());
  doc.querySelector('.cf-add-tile').click();
  const search = doc.getElementById('cf-add-search');
  search.value = 'Terrine de campagne';
  search.dispatchEvent(new win.Event('input', { bubbles: true }));
  doc.querySelector('.cf-add-item.create').click();
  await sleep(30);
  doc.querySelectorAll('.dlc-quick')[2].click(); // J+7
  await sleep(30);
  win.cfAddStep(1);
  win.cfAddStep(1);
  doc.getElementById('cf-add-confirm').click();
  await sleep(50);

  const [code, nom] = Object.entries(read(win, 'produits.json')).find(([, n]) => n === 'Terrine de campagne');
  assert.ok(code.startsWith('BA'), 'code d\'étiquette maison, comme l\'onglet Étiquettes');
  const lot = read(win, 'chambre-froide.json').find(s => s.nom === nom);
  assert.equal(lot.qty, 3);
  assert.equal(lot.codePhysique, code);
  assert.equal(lot.dateEntree, today());
  assert.ok(lot.dlc > today());
  assert.ok(doc.querySelector('#result-area .btn-print'), 'impression de l\'étiquette proposée');
  assert.equal(doc.getElementById('cf-add-modal').style.display, 'none');

  await scan(win, code);
  assert.equal(read(win, 'chambre-froide.json').find(s => s.nom === nom).qty, 2);
  assert.equal(read(win, `jours/${today()}.json`).at(-1).action, 'sortie');
  assert.deepEqual(errors, []);
});

test('tuile chambre froide : article existant choisi dans la liste ou scanné', async () => {
  const { win, doc, errors } = await openPage('index.html', await seededStorage());
  doc.querySelector('.cf-add-tile').click();
  const search = doc.getElementById('cf-add-search');
  search.value = 'sauciss';
  search.dispatchEvent(new win.Event('input', { bubbles: true }));
  const items = [...doc.querySelectorAll('#cf-add-list .cf-add-item')];
  items.find(i => i.textContent.includes('Saucisson sec')).click();
  await sleep(30);
  doc.querySelector('.dlc-quick').click();
  await sleep(30);
  doc.getElementById('cf-add-confirm').click();
  await sleep(50);
  const lot = read(win, 'chambre-froide.json').find(s => s.nom === 'Saucisson sec');
  assert.equal(lot.codePhysique, '3700001');
  assert.equal(lot.qty, 1);
  assert.equal(read(win, `jours/${today()}.json`), null, 'une entrée n\'est pas une sortie');

  // Scan d'un produit connu pendant que la fenêtre est ouverte → choisi directement
  doc.querySelector('.cf-add-tile').click();
  await scan(win, 'BA12AB');
  assert.equal(doc.querySelector('.dlc-picker-sub').textContent, 'Pâté maison');
  doc.querySelector('.dlc-quick').click();
  await sleep(30);
  doc.getElementById('cf-add-confirm').click();
  await sleep(50);
  assert.ok(read(win, 'chambre-froide.json').some(s => s.nom === 'Pâté maison' && s.codePhysique === 'BA12AB'));
  assert.deepEqual(errors, []);
});

test('sortie sans scanner : lot choisi dans la liste (même sans code-barres) → retiré + historique', async () => {
  const storage = await seededStorage();
  const stock = JSON.parse(storage['sbf:data/chambre-froide.json']);
  stock.push({ id: 'm1', nom: 'Boudin blanc', dlc: '2099-01-01', qty: 1, codeFacture: null, codePhysique: null, dateEntree: '2026-09-20' });
  storage['sbf:data/chambre-froide.json'] = JSON.stringify(stock);
  const { win, doc, errors } = await openPage('index.html', storage);
  // Même en mode « réception viande », la tuile fait une vraie sortie
  win.eval("mode = 'viande'");
  doc.getElementById('cf-out-tile').click();
  await sleep(30);
  const row = [...doc.querySelectorAll('.cf-picker-item')].find(r => r.textContent.includes('Boudin blanc'));
  assert.match(row.textContent, /entré le 20\/09\/2026/);
  row.click();
  await sleep(20);
  doc.getElementById('lot-sortie').click();
  await sleep(80);
  assert.equal(read(win, 'chambre-froide.json').find(s => s.id === 'm1'), undefined);
  const hist = read(win, `jours/${today()}.json`);
  assert.equal(hist[0].nom, 'Boudin blanc');
  assert.equal(hist[0].action, 'sortie');
  assert.equal(read(win, 'produits.json')[''], undefined, 'pas de produit au code vide');
  // Annuler remet le lot
  doc.querySelector('.btn-undo').click();
  await sleep(80);
  assert.ok(read(win, 'chambre-froide.json').find(s => s.id === 'm1'));
  assert.deepEqual(errors, []);
});

test('chambre froide : chaque lot affiche sa date d\'entrée, les lots sans date peuvent être datés', async () => {
  const storage = await seededStorage();
  const stock = JSON.parse(storage['sbf:data/chambre-froide.json']);
  stock.push({ id: 'old1', nom: 'Lard', dlc: '2099-01-01', qty: 1 }, { id: 'old2', nom: 'Poitrine', dlc: '2099-01-02', qty: 1 });
  storage['sbf:data/chambre-froide.json'] = JSON.stringify(stock);
  const { win, doc, errors } = await openPage('chambre-froide.html', storage);
  const texts = [...doc.querySelectorAll('.stock-item-entree')].map(e => e.textContent);
  assert.equal(texts.length, 5);
  assert.equal(texts.filter(t => t.includes('Entré le 01/09/2026')).length, 3);
  assert.equal(doc.querySelectorAll('.stock-item-entree.missing').length, 2);

  // Tous les lots sans date d'un coup
  [...doc.querySelectorAll('button')].find(b => b.textContent.includes('sans date d\'entrée')).click();
  await sleep(20);
  doc.querySelector('.dlc-date-input').value = '2026-09-15';
  doc.querySelector('.dlc-picker .dlc-ok').click();
  await sleep(50);
  let after = read(win, 'chambre-froide.json');
  assert.equal(after.find(s => s.id === 'old1').dateEntree, '2026-09-15');
  assert.equal(after.find(s => s.id === 'old2').dateEntree, '2026-09-15');
  assert.equal(after.find(s => s.id === 'cf_1').dateEntree, '2026-09-01');

  // Un seul lot : appui sur sa date
  win.editDateEntree('old1');
  await sleep(20);
  doc.querySelector('.dlc-date-input').value = '2026-09-10';
  doc.querySelector('.dlc-picker .dlc-ok').click();
  await sleep(50);
  after = read(win, 'chambre-froide.json');
  assert.equal(after.find(s => s.id === 'old1').dateEntree, '2026-09-10');
  assert.equal(after.find(s => s.id === 'old2').dateEntree, '2026-09-15');
  assert.deepEqual(errors, []);
});

// ── Bandeau DLC, fiche de lot (quantité, jeté, congeler), récents, tri/recherche ──
const inDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function storageWithLots(lots) {
  const storage = await seededStorage();
  const stock = JSON.parse(storage['sbf:data/chambre-froide.json']);
  stock.push(...lots);
  storage['sbf:data/chambre-froide.json'] = JSON.stringify(stock);
  return storage;
}

test('bandeau DLC : périmés / aujourd\'hui-demain / sous 3 jours, appui → liste des lots concernés', async () => {
  const { win, doc, errors } = await openPage('index.html', await storageWithLots([
    { id: 'e1', nom: 'Merguez', dlc: inDays(-1), qty: 2, dateEntree: '2026-09-01' },
    { id: 'u1', nom: 'Chipolatas', dlc: inDays(1), qty: 1, dateEntree: '2026-09-01' },
    { id: 's1', nom: 'Boudin', dlc: inDays(3), qty: 1, dateEntree: '2026-09-01' },
  ]));
  const banner = doc.getElementById('dlc-banner');
  assert.ok(banner.classList.contains('visible') && banner.classList.contains('hot'));
  assert.match(banner.textContent, /1 périmé/);
  assert.match(banner.textContent, /1 DLC aujourd'hui \/ demain/);
  assert.match(banner.textContent, /1 sous 3 jours/);
  banner.click();
  await sleep(30);
  const names = [...doc.querySelectorAll('.cf-picker-item-nom')].map(e => e.textContent);
  assert.equal(names.length, 3, 'seulement les lots urgents');
  assert.match(names[0], /Merguez/, 'le plus urgent en premier');

  // Jeter le lot périmé en entier
  doc.querySelector('.cf-picker-item').click();
  await sleep(20);
  [...doc.querySelectorAll('.qty-all')][0].click();
  doc.getElementById('lot-perte').click();
  await sleep(80);
  assert.equal(read(win, 'chambre-froide.json').find(s => s.id === 'e1'), undefined);
  const h = read(win, `jours/${today()}.json`)[0];
  assert.equal(h.action, 'perte');
  assert.equal(h.qty, 2);
  assert.match(doc.getElementById('result-area').textContent, /2 jetés \(perte\)/);
  assert.doesNotMatch(banner.textContent, /périmé/, 'bandeau mis à jour');
  assert.match(doc.getElementById('recent-list').textContent, /🗑️ Merguez ×2/);
  assert.deepEqual(errors, []);
});

test('fiche de lot : sortir 2 pièces d\'un coup, annuler remet les 2', async () => {
  const { win, doc } = await openPage('index.html', await seededStorage());
  doc.getElementById('cf-out-tile').click();
  await sleep(20);
  [...doc.querySelectorAll('.cf-picker-item')].find(r => r.textContent.includes('Jambon cru')).click();
  await sleep(20);
  win.lotStep(1);
  doc.getElementById('lot-sortie').click();
  await sleep(80);
  assert.equal(read(win, 'chambre-froide.json').find(s => s.id === 'cf_3').qty, 1);
  assert.equal(read(win, `jours/${today()}.json`)[0].qty, 2);
  doc.querySelector('.btn-undo').click();
  await sleep(80);
  assert.equal(read(win, 'chambre-froide.json').find(s => s.id === 'cf_3').qty, 3);
  assert.equal(read(win, `jours/${today()}.json`).length, 0);
});

test('fiche de lot : congeler → retiré de la chambre froide, ajouté au congélateur, annulable', async () => {
  const { win, doc } = await openPage('index.html', await seededStorage());
  doc.getElementById('cf-out-tile').click();
  await sleep(20);
  [...doc.querySelectorAll('.cf-picker-item')].find(r => r.textContent.includes('Jambon cru')).click();
  await sleep(20);
  win.lotStep(1);
  doc.getElementById('lot-congelation').click();
  await sleep(80);
  assert.equal(read(win, 'chambre-froide.json').find(s => s.id === 'cf_3').qty, 1);
  let fz = read(win, 'congelateur.json');
  assert.equal(fz.filter(f => f.nom === 'Jambon cru' && f.date === today()).length, 2);
  assert.equal(fz.length, 3, 'l\'ancien contenu du congélateur est gardé');
  assert.equal(read(win, `jours/${today()}.json`)[0].action, 'congelation');
  doc.querySelector('.btn-undo').click();
  await sleep(80);
  fz = read(win, 'congelateur.json');
  assert.equal(fz.length, 1);
  assert.equal(read(win, 'chambre-froide.json').find(s => s.id === 'cf_3').qty, 3);
});

test('page chambre froide : appui sur un lot → corriger la DLC / la date d\'entrée, ou aller le sortir', async () => {
  const storage = await seededStorage();
  const { win, doc, errors } = await openPage('chambre-froide.html', storage);
  const openJambon = () => [...doc.querySelectorAll('.stock-item-info')].find(e => e.textContent.includes('Jambon cru')).click();
  openJambon();
  assert.match(doc.querySelector('.lot-edit-overlay').textContent, /01\/02\/2099/);

  // DLC mal importée : on peut la corriger, même vers une date passée
  doc.querySelector('.lot-edit-dlc').click();
  await sleep(20);
  const input = [...doc.querySelectorAll('.dlc-picker .dlc-date-input')].at(-1);
  assert.equal(input.value, '2099-02-01', 'DLC actuelle proposée');
  assert.equal(input.getAttribute('min'), null, 'date passée permise pour une correction');
  input.value = '2026-09-20';
  [...doc.querySelectorAll('.dlc-picker .dlc-ok')].at(-1).click();
  await sleep(50);
  assert.equal(read(win, 'chambre-froide.json').find(s => s.id === 'cf_3').dlc, '2026-09-20');
  assert.match(doc.querySelector('.lot-edit-overlay').textContent, /20\/09\/2026/, 'fiche mise à jour');

  // Date d'entrée
  doc.querySelector('.lot-edit-entree').click();
  await sleep(20);
  [...doc.querySelectorAll('.dlc-picker .dlc-date-input')].at(-1).value = '2026-09-18';
  [...doc.querySelectorAll('.dlc-picker .dlc-ok')].at(-1).click();
  await sleep(50);
  assert.equal(read(win, 'chambre-froide.json').find(s => s.id === 'cf_3').dateEntree, '2026-09-18');

  // Sortir, jeter, congeler : fiche du lot sur l'accueil
  let target = null;
  win.openLot = id => { target = id; }; // la navigation n'existe pas dans jsdom
  doc.querySelector('.lot-edit-out').click();
  assert.equal(target, 'cf_3');
  assert.deepEqual(errors, []);

  // Pas de collision avec le bouton vert « OK » du choix de DLC (fond vert illisible)
  assert.equal(doc.querySelectorAll('.stock-item.dlc-ok').length, 0);

  // Arrivée sur l'accueil avec #lot=…
  const dom2 = await (async () => {
    const r = await openPage('index.html', storage);
    return r;
  })();
  dom2.win.openCfPicker('sortie');
  await sleep(20);
  dom2.win.pickCfItem('cf_3');
  assert.ok(dom2.doc.getElementById('lot-sortie'));
  assert.match(dom2.doc.getElementById('cf-picker-list').textContent, /3 en stock/);
});

test('page chambre froide : recherche et tri (mémorisé)', async () => {
  const storage = await storageWithLots([{ id: 'n1', nom: 'Andouillette', dlc: '2099-06-01', qty: 1, dateEntree: '2026-09-23' }]);
  const { win, doc } = await openPage('chambre-froide.html', storage);
  const names = () => [...doc.querySelectorAll('.stock-item-name')].map(e => e.textContent);
  assert.equal(names()[0], 'Faux-filet', 'par DLC par défaut');
  win.setStockSort('nom');
  assert.equal(names()[0], 'Andouillette');
  win.setStockSort('entree');
  assert.equal(names()[0], 'Andouillette', 'entrée la plus récente en premier');
  const search = doc.getElementById('stock-search');
  search.value = 'faux';
  search.dispatchEvent(new win.Event('input'));
  assert.deepEqual(names(), ['Faux-filet', 'Faux-filet']);
  assert.match(doc.querySelector('.stock-count').textContent, /2 sur 4/);
  assert.equal(win.localStorage.getItem('sb_cf_sort'), 'entree');
});

test('mettre en chambre froide : derniers articles rangés proposés en gros boutons', async () => {
  const { win, doc } = await openPage('index.html', await seededStorage());
  doc.querySelector('.cf-add-tile').click();
  assert.equal(doc.querySelectorAll('.recent-btn').length, 0);
  win.cfAddChoose('3700001');
  await sleep(20);
  doc.querySelector('.dlc-picker .dlc-quick').click();
  await sleep(20);
  doc.getElementById('cf-add-confirm').click();
  await sleep(50);
  doc.querySelector('.cf-add-tile').click();
  const btns = [...doc.querySelectorAll('.recent-btn')];
  assert.equal(btns.length, 1);
  assert.equal(btns[0].textContent, 'Saucisson sec');
  // Un appui → DLC directement
  btns[0].click();
  await sleep(20);
  assert.equal(doc.querySelector('.dlc-picker-sub').textContent, 'Saucisson sec');
});

test('étiquette de lot : DLC et date d\'entrée imprimées, une par pièce', async () => {
  const { win, doc } = await openPage('index.html', await seededStorage());
  win.printLotLabels('BA12AB', 'Pâté maison', '2099-01-05', '2026-09-24', 3);
  const area = doc.getElementById('print-area');
  assert.equal(area.querySelectorAll('svg').length, 3);
  assert.match(area.textContent, /DLC 05\/01\/2099/);
  assert.match(area.textContent, /Entré le 24\/09\/2026/);
});

// ── Articles qui changent de code-barres (alias) ──
const aliasBtn = (doc, nom) => [...doc.querySelectorAll('#cf-link-area .alias-btn')].find(b => b.textContent.replace('🧊 ', '') === nom);

test('code inconnu : sans code-barres en haut, autres dessous, recherche ; le code est ajouté à l\'article choisi', async () => {
  const { win, doc, errors } = await openPage('index.html', await seededStorage());
  await scan(win, '777000');
  await sleep(30);
  const sections = [...doc.querySelectorAll('.alias-section')].map(e => e.textContent);
  assert.match(sections[0], /Sans code-barres \(1\)/);
  assert.match(sections[1], /Autres articles/);
  const lists = doc.querySelectorAll('#cf-link-area .alias-list');
  assert.match(lists[0].textContent, /Jambon cru/, 'lot de la chambre froide sans code en haut');
  assert.doesNotMatch(lists[1].textContent, /Jambon cru/);
  assert.match(lists[1].textContent, /Faux-filet/);
  assert.match(lists[1].textContent, /Saucisson sec/);

  // Recherche
  const search = doc.getElementById('alias-search');
  search.value = 'faux';
  search.dispatchEvent(new win.Event('input'));
  assert.equal(doc.querySelectorAll('#cf-link-area .alias-btn').length, 1);

  // Faux-filet a déjà un code (2000100) : 777000 devient un deuxième code du même article
  aliasBtn(doc, 'Faux-filet').click();
  await sleep(80);
  assert.equal(read(win, 'produits.json')['777000'], 'Faux-filet');
  assert.equal(read(win, 'chambre-froide.json').find(s => s.id === 'cf_2'), undefined, 'lot à DLC la plus proche sorti');
  assert.equal(read(win, `jours/${today()}.json`)[0].nom, 'Faux-filet');

  // La fois suivante, ce code est reconnu directement
  await scan(win, '777000');
  assert.equal(read(win, 'chambre-froide.json').find(s => s.id === 'cf_1').qty, 1);
  assert.equal(read(win, `jours/${today()}.json`).length, 2);
  assert.deepEqual(errors, []);
});

test('code inconnu : taper un nom existant (casse / accents différents) le rattache au même article', async () => {
  const { win, doc } = await openPage('index.html', await seededStorage());
  await scan(win, '555000');
  const input = doc.getElementById('name-input');
  input.value = 'pate MAISON';
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(80);
  assert.equal(read(win, 'produits.json')['555000'], 'Pâté maison');
});

test('réception DLC : deux codes différents du même article → même lot', async () => {
  const { win, doc } = await openPage('index.html', await seededStorage());
  doc.querySelector('.mode-btn[data-mode="dlc"]').click();
  await sleep(20);
  await scan(win, '3700001');
  doc.querySelector('.dlc-picker .dlc-quick').click();
  await sleep(50);
  await scan(win, '999111');
  doc.querySelector('.dlc-picker .dlc-quick').click();
  await sleep(50);
  aliasBtn(doc, 'Saucisson sec').click();
  await sleep(80);
  const lots = read(win, 'chambre-froide.json').filter(s => s.nom === 'Saucisson sec');
  assert.equal(lots.length, 1);
  assert.equal(lots[0].qty, 2);
});

test('réception viande : poches à codes différents regroupées dans le même lot', async () => {
  const { win, doc } = await openPage('index.html', await seededStorage());
  doc.querySelector('.mode-btn[data-mode="viande"]').click();
  await sleep(20);
  doc.querySelector('.dlc-picker .dlc-quick').click();
  await sleep(20);
  await scan(win, '4000001');
  const input = doc.getElementById('meat-name-input');
  input.value = 'Bavette';
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(80);
  await scan(win, '4000002');
  aliasBtn(doc, 'Bavette').click();
  await sleep(80);
  await scan(win, '4000002');
  const lots = read(win, 'chambre-froide.json').filter(s => s.nom === 'Bavette');
  assert.equal(lots.length, 1);
  assert.equal(lots[0].qty, 3);
});

test('renommer un article renomme tous ses codes et ses lots', async () => {
  const storage = await seededStorage();
  const prod = JSON.parse(storage['sbf:data/produits.json']);
  prod['2000100'] = 'Faux-filet';
  prod['2000999'] = 'Faux-filet';
  storage['sbf:data/produits.json'] = JSON.stringify(prod);
  const { win } = await openPage('index.html', storage);
  await win.renameProductEverywhere('2000999', 'Faux-filet de bœuf');
  const p = read(win, 'produits.json');
  assert.equal(p['2000100'], 'Faux-filet de bœuf');
  assert.equal(p['2000999'], 'Faux-filet de bœuf');
  assert.ok(read(win, 'chambre-froide.json').filter(s => s.codeFacture === 'F100').every(s => s.nom === 'Faux-filet de bœuf'));
});

test('page articles : un article à plusieurs codes = une seule fiche, code retirable', async () => {
  const storage = await seededStorage();
  const prod = JSON.parse(storage['sbf:data/produits.json']);
  prod['3700002'] = 'Saucisson sec';
  storage['sbf:data/produits.json'] = JSON.stringify(prod);
  const { win, doc, errors } = await openPage('articles.html', storage);
  const cards = [...doc.querySelectorAll('.article-card')].filter(c => c.querySelector('.article-name').textContent === 'Saucisson sec');
  assert.equal(cards.length, 1);
  assert.match(cards[0].textContent, /3700001/);
  assert.match(cards[0].textContent, /3700002/);
  win.openEditModal('p_3700001');
  assert.match(doc.getElementById('code-list').textContent, /3700002/);
  await win.removeArticleCode('3700002');
  assert.equal(read(win, 'produits.json')['3700002'], undefined);
  assert.equal(read(win, 'produits.json')['3700001'], 'Saucisson sec');
  assert.deepEqual(errors, []);
});

test('mettre en chambre froide : code scanné inconnu + article existant choisi → code ajouté', async () => {
  const { win, doc } = await openPage('index.html', await seededStorage());
  doc.querySelector('.cf-add-tile').click();
  await scan(win, '123123');
  [...doc.querySelectorAll('#cf-add-list .cf-add-item')].find(i => i.textContent.includes('Pâté maison')).click();
  await sleep(30);
  doc.querySelector('.dlc-picker .dlc-quick').click();
  await sleep(20);
  doc.getElementById('cf-add-confirm').click();
  await sleep(50);
  assert.equal(read(win, 'produits.json')['123123'], 'Pâté maison');
  assert.ok(read(win, 'chambre-froide.json').some(s => s.nom === 'Pâté maison' && s.codePhysique === '123123'));
});

// ── Produits maison (fabrications) ──
const fabItem = (doc, nom) => [...doc.querySelectorAll('#fab-choices .cf-add-item')].find(i => i.textContent.includes(nom));

test('fabrication : nouveau produit → lot numéroté, rangé en chambre froide, étiquettes avec n° de lot', async () => {
  const { win, doc, errors } = await openPage('index.html', await seededStorage());
  win.switchTab('maison');
  await sleep(30);
  doc.querySelector('.fab-tile').click();
  await sleep(30);
  const input = doc.getElementById('fab-search-input');
  input.value = 'Merguez';
  input.dispatchEvent(new win.Event('input'));
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(50);
  [...doc.querySelectorAll('.dlc-picker .dlc-quick')].find(b => b.textContent.includes('J+3')).click();
  await sleep(20);
  doc.querySelectorAll('#fab-body .qty-stepper button')[1].click();
  doc.querySelectorAll('#fab-body .qty-stepper button')[1].click();
  doc.getElementById('fab-confirm').click();
  await sleep(60);
  const fabs = read(win, 'fabrications.json');
  assert.equal(fabs.length, 1);
  const f = fabs[0];
  const lot = 'F' + today().slice(2).replace(/-/g, '') + '-1';
  assert.equal(f.lot, lot);
  assert.equal(f.qty, 3);
  assert.equal(f.date, today());
  assert.ok(f.code.startsWith('BA'));
  assert.equal(read(win, 'produits.json')[f.code], 'Merguez');
  const cf = read(win, 'chambre-froide.json').find(s => s.id === f.cfId);
  assert.equal(cf.qty, 3);
  assert.equal(cf.dlc, f.dlc);
  assert.equal(cf.lotFab, lot);
  const area = doc.getElementById('print-area');
  assert.equal(area.querySelectorAll('svg').length, 3);
  assert.match(area.textContent, new RegExp('Lot ' + lot));
  assert.match(area.textContent, /Fabriqué le/);
  assert.match(doc.getElementById('fab-list').textContent, /3 en chambre froide/);
  assert.deepEqual(errors.filter(e => !/print\(\)/.test(e)), []); // jsdom n'a pas window.print
});

test('fabrication : « Refaire » reprend la même durée de DLC, n° de lot suivant ; sortie par scan', async () => {
  const storage = await seededStorage();
  storage['sbf:data/fabrications.json'] = JSON.stringify([
    { id: 'fab_1', lot: 'F' + today().slice(2).replace(/-/g, '') + '-1', code: 'BA12AB', nom: 'Pâté maison',
      date: '2026-09-01', dlc: '2026-09-08', qty: 2, cfId: null, createdAt: '2026-09-01T08:00:00Z' },
  ]);
  const { win, doc, errors } = await openPage('index.html', storage);
  win.switchTab('maison');
  await sleep(30);
  [...doc.querySelectorAll('#fab-again .recent-btn')].find(b => b.textContent.includes('Pâté maison')).click();
  await sleep(30);
  assert.equal(doc.querySelector('.dlc-picker'), null); // pas de question : J+7 comme la dernière fois
  doc.getElementById('fab-to-cf').checked = true;
  doc.getElementById('fab-confirm-noprint').click();
  await sleep(60);
  const f = read(win, 'fabrications.json').find(x => x.id !== 'fab_1');
  assert.equal(f.dlc, (() => { const d = new Date(); d.setDate(d.getDate() + 7); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })());
  assert.match(f.lot, /-2$/);
  assert.equal(doc.getElementById('print-area').innerHTML, '');
  // L'étiquette imprimée (code de l'article) se sort de la chambre froide par le scan habituel
  win.switchTab('scan');
  await scan(win, 'BA12AB');
  await sleep(50);
  assert.equal(read(win, 'chambre-froide.json').find(s => s.id === f.cfId), undefined);
  assert.deepEqual(errors, []);
});

test('fabrication : code scanné dans la fenêtre → produit choisi ; suppression retire le lot de la chambre froide', async () => {
  const { win, doc } = await openPage('index.html', await seededStorage());
  win.switchTab('maison');
  await sleep(30);
  doc.querySelector('.fab-tile').click();
  await sleep(30);
  await scan(win, 'BA12AB');
  await sleep(30);
  doc.querySelector('.dlc-picker .dlc-quick').click();
  await sleep(20);
  assert.match(doc.getElementById('fab-body').textContent, /Pâté maison/);
  doc.getElementById('fab-confirm-noprint').click();
  await sleep(60);
  const f = read(win, 'fabrications.json')[0];
  assert.ok(read(win, 'chambre-froide.json').some(s => s.id === f.cfId));
  await win.deleteFab(f.id);
  assert.deepEqual(read(win, 'fabrications.json'), []);
  assert.ok(!read(win, 'chambre-froide.json').some(s => s.id === f.cfId));
});
