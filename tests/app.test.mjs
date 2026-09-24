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
