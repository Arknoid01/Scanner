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
