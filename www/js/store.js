// ═══════════════════════════════════════
// STORE — stockage local (remplace Google Drive)
// ═══════════════════════════════════════
// Sur la tablette : fichiers JSON dans le dossier privé de l'app (plugin natif ScannerNative).
// Dans un navigateur (tests) : repli sur localStorage.
//
// Structure :
//   data/produits.json, data/chambre-froide.json, data/congelateur.json, data/cf-mapping.json
//   data/jours/AAAA-MM-JJ.json   (historique, un fichier par jour)
//
// Les sauvegardes ZIP reprennent l'arborescence de l'ancien dossier Drive
// (« Scanner Boucherie/produits.json », « Scanner Boucherie/AAAA-MM-JJ/AAAA-MM-JJ.json »),
// donc un seul import gère à la fois un ZIP téléchargé depuis Drive et une sauvegarde de l'app.

const Store = (() => {
  const NAMED_FILES = ['produits.json', 'chambre-froide.json', 'congelateur.json', 'cf-mapping.json'];
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const ZIP_ROOT = 'Scanner Boucherie';

  // ── Backend : natif si disponible, sinon localStorage ──
  const native = (window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform())
    ? Capacitor.registerPlugin('ScannerNative')
    : null;

  const LS = 'sbf:';
  const backend = native ? {
    async read(path) { const r = await native.readFile({ path }); return r.exists ? r.data : null; },
    async write(path, data) { await native.writeFile({ path, data }); },
    async remove(path) { await native.deleteFile({ path }); },
    async list(dir) { const r = await native.listFiles({ dir }); return r.files || []; },
  } : {
    async read(path) { try { return localStorage.getItem(LS + path); } catch { return null; } },
    async write(path, data) { localStorage.setItem(LS + path, data); },
    async remove(path) { try { localStorage.removeItem(LS + path); } catch {} },
    async list(dir) {
      const prefix = LS + dir + '/';
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) out.push(k.slice(prefix.length));
      }
      return out;
    },
  };

  // ── Cache mémoire + écritures sérialisées par fichier ──
  const mem = new Map();    // path → données parsées
  const locks = new Map();  // path → Promise de la dernière écriture

  function serialize(path, fn) {
    const prev = locks.get(path) || Promise.resolve();
    const cur = prev.then(fn, fn);
    locks.set(path, cur);
    return cur;
  }

  async function readJson(path) {
    if (mem.has(path)) return mem.get(path);
    await (locks.get(path) || Promise.resolve());
    const raw = await backend.read(path);
    let data = null;
    if (raw != null) { try { data = JSON.parse(raw); } catch { data = null; } }
    mem.set(path, data);
    return data;
  }

  function writeJson(path, data) {
    mem.set(path, data);
    const text = JSON.stringify(data, null, 2);
    return serialize(path, () => backend.write(path, text));
  }

  const namedPath = name => `data/${name}`;
  const dayPath = date => `data/jours/${date}.json`;

  // ── API ──
  async function load(name) { return readJson(namedPath(name)); }
  async function save(name, data) { return writeJson(namedPath(name), data); }

  async function loadDay(date) {
    const d = await readJson(dayPath(date));
    return Array.isArray(d) ? [...d] : [];
  }
  async function saveDay(date, entries) { return writeJson(dayPath(date), entries); }

  async function deleteDay(date) {
    const p = dayPath(date);
    mem.delete(p);
    return serialize(p, () => backend.remove(p));
  }

  // Jours présents, du plus récent au plus ancien
  async function listDays() {
    const files = await backend.list('data/jours');
    return files.map(f => f.replace(/\.json$/, '')).filter(d => DAY_RE.test(d)).sort().reverse();
  }

  // Ajoute une ligne à l'historique du jour, renvoie l'entrée créée
  async function addHistoryEntry(entry) {
    const now = new Date();
    const date = entry.date || localDateStr(now);
    const e = { heure: entry.heure || now.toTimeString().slice(0, 5), code: entry.code, nom: entry.nom };
    if (entry.action) e.action = entry.action;
    e.id = 'h_' + now.getTime() + '_' + Math.random().toString(36).slice(2, 6);
    const entries = await loadDay(date);
    entries.push(e);
    await saveDay(date, entries);
    return { ...e, date };
  }

  async function removeHistoryEntry(date, id) {
    const entries = await loadDay(date);
    const next = entries.filter(e => e.id !== id);
    if (next.length !== entries.length) await saveDay(date, next);
  }

  // Supprime l'historique de plus de N mois (2 par défaut, comme avant)
  async function cleanOldDays(months = 2) {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const cut = localDateStr(cutoff);
    for (const d of await listDays()) if (d < cut) await deleteDay(d);
  }

  // ── Sauvegarde / import ZIP ──
  async function buildZip() {
    const zip = new JSZip();
    const root = zip.folder(ZIP_ROOT);
    for (const name of NAMED_FILES) {
      const data = await load(name);
      if (data != null) root.file(name, JSON.stringify(data, null, 2));
    }
    for (const d of await listDays()) {
      root.folder(d).file(`${d}.json`, JSON.stringify(await loadDay(d), null, 2));
    }
    return zip;
  }

  async function exportZipBase64() {
    const zip = await buildZip();
    return zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
  }

  // Lit un ou plusieurs ZIP (Drive coupe parfois en plusieurs morceaux) et renvoie ce qui a été trouvé,
  // sans rien écrire. Les doublons de Drive (« produits (1).json ») sont départagés : on garde le plus gros.
  async function parseZips(files) {
    const found = { named: {}, days: {} };
    const sizes = {};
    for (const file of files) {
      const zip = await JSZip.loadAsync(file);
      const entries = Object.values(zip.files).filter(f => !f.dir && f.name.toLowerCase().endsWith('.json'));
      for (const f of entries) {
        const base = f.name.split('/').pop().replace(/\s*\(\d+\)(?=\.json$)/i, '');
        const text = await f.async('string');
        let data;
        try { data = JSON.parse(text); } catch { continue; }
        const stem = base.replace(/\.json$/i, '');
        if (DAY_RE.test(stem) && Array.isArray(data)) {
          // Même jour présent plusieurs fois : on fusionne sans doublon
          const cur = found.days[stem] || [];
          const seen = new Set(cur.map(entryKey));
          for (const e of data) if (!seen.has(entryKey(e))) { cur.push(e); seen.add(entryKey(e)); }
          found.days[stem] = cur;
        } else if (NAMED_FILES.includes(base)) {
          if (!(base in sizes) || text.length > sizes[base]) { found.named[base] = data; sizes[base] = text.length; }
        }
      }
    }
    return found;
  }

  function summarize(found) {
    const n = found.named;
    return {
      produits: n['produits.json'] ? Object.keys(n['produits.json']).length : 0,
      chambreFroide: Array.isArray(n['chambre-froide.json']) ? n['chambre-froide.json'].length : 0,
      congelateur: Array.isArray(n['congelateur.json']) ? n['congelateur.json'].length : 0,
      liaisons: n['cf-mapping.json'] ? Object.keys(n['cf-mapping.json']).length : 0,
      jours: Object.keys(found.days).length,
      scans: Object.values(found.days).reduce((a, d) => a + d.length, 0),
    };
  }

  // Remplace les fichiers principaux par ceux du ZIP ; l'historique est fusionné jour par jour
  async function applyImport(found) {
    for (const [name, data] of Object.entries(found.named)) await save(name, data);
    for (const [date, entries] of Object.entries(found.days)) {
      const cur = await loadDay(date);
      const seen = new Set(cur.map(entryKey));
      for (const e of entries) if (!seen.has(entryKey(e))) { cur.push(e); seen.add(entryKey(e)); }
      cur.sort((a, b) => (a.heure || '').localeCompare(b.heure || ''));
      await saveDay(date, cur);
    }
  }

  function entryKey(e) { return e.id || `${e.heure}|${e.code}|${e.nom}`; }

  // Sauvegarde automatique : une par jour dans Téléchargements/ScannerBoucherie (14 gardées)
  async function backupNow() {
    if (!native) throw new Error('Sauvegarde disponible seulement sur la tablette');
    const base64 = await exportZipBase64();
    const filename = `sauvegarde-${localDateStr(new Date())}.zip`;
    await native.saveBackup({ filename, base64, keep: 14 });
    try { localStorage.setItem('sb_last_backup', localDateStr(new Date())); } catch {}
    return filename;
  }

  async function autoBackupIfNeeded() {
    if (!native) return;
    let last = null;
    try { last = localStorage.getItem('sb_last_backup'); } catch {}
    if (last === localDateStr(new Date())) return;
    try { await backupNow(); } catch (e) { console.error('Sauvegarde auto échouée', e); }
  }

  function lastBackup() { try { return localStorage.getItem('sb_last_backup'); } catch { return null; } }

  return {
    native, load, save, loadDay, saveDay, deleteDay, listDays,
    addHistoryEntry, removeHistoryEntry, cleanOldDays,
    exportZipBase64, parseZips, summarize, applyImport,
    backupNow, autoBackupIfNeeded, lastBackup,
  };
})();

// Date locale AAAA-MM-JJ (toISOString donnerait la date UTC : faux entre minuit et 2 h en été)
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
