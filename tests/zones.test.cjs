// Test : zones de contrôle autour des radars fixes (sans jamais indiquer l'emplacement exact du radar).
// Route droite de 3 km limitée à 80, radar (OpenStreetMap highway=speed_camera) à 2 000 m, un peu à côté de la route.
// Voiture à 108 km/h (faux GPS). On vérifie : zone de 2 km qui contient le radar sans commencer ni finir dessus,
// entrée de zone annoncée comme un obstacle à 80 km/h (lever le pied avant), pastille et voix en zone, réglage pour couper.
// Lancement : node tests/zones.test.cjs   (dossier de l'appli en argument, par défaut le dépôt)
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const DIR = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const LAT0 = 47.2184, LON0 = -1.5536, V = 30, mLat = 1 / 111320, mLon = 1 / (111320 * Math.cos(LAT0 * Math.PI / 180));
const geo = []; for (let i = 0; i < 301; i++) geo.push({ lat: LAT0 + i * 10 * mLat, lon: LON0 });
const CAM = { lat: LAT0 + 2000 * mLat, lon: LON0 + 6 * mLon };
const overpass = JSON.stringify({ elements: [
  { type: 'way', id: 1, nodes: geo.map((_, i) => 1000 + i), geometry: geo, tags: { highway: 'primary', maxspeed: '80' } },
  { type: 'node', id: 777, lat: CAM.lat, lon: CAM.lon, tags: { highway: 'speed_camera', maxspeed: '80' } }] });

function serve() { return new Promise(res => { const s = http.createServer((req, rsp) => {
  const f = path.join(DIR, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  fs.readFile(f, (e, b) => { if (e) { rsp.writeHead(404); return rsp.end(); }
    if (f.endsWith('.html')) b = b.toString().replace(/\}\)\(\);\s*<\/script>\s*<\/body>/, 'window.__PL={get S(){return S},get MAP(){return MAP}};})();</script></body>');
    rsp.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); rsp.end(b); }); }).listen(0, () => res(s)); }); }

async function run(browser, port, off) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); const spoken = [];
  await page.exposeFunction('__spoke', t => spoken.push(t));
  await page.route('**/*', r => { const u = r.request().url();
    if (u.startsWith(`http://localhost:${port}`)) return r.continue();
    if (u.includes('/interpreter')) return r.fulfill({ status: 200, contentType: 'application/json', body: overpass });
    return r.abort(); });
  await page.addInitScript(({ LAT0, LON0, mLat, V, off }) => {
    if (off) localStorage.setItem('pl-zones', '0');
    navigator.geolocation.watchPosition = ok => { const t0 = performance.now(); const tick = () => { const s = 100 + V * (performance.now() - t0) / 1000; ok({ coords: { latitude: LAT0 + s * mLat, longitude: LON0, accuracy: 5, speed: V, heading: 0 }, timestamp: Date.now() }); setTimeout(tick, 1000); }; tick(); return 1; };
    navigator.geolocation.clearWatch = () => {};
    try { speechSynthesis.speak = u => window.__spoke(u.text); } catch (e) {} }, { LAT0, LON0, mLat, V, off });
  await page.goto(`http://localhost:${port}/`); await page.waitForTimeout(600);
  await page.click('#bReal');
  await page.evaluate(() => { window.__ev = null; window.__chip = []; setInterval(() => { const S = window.__PL.S; const z = S.ev.find(e => e.type === 'zone'); if (z && !window.__ev) window.__ev = { d: z.d, vt: z.vt, odo: S.odo };
    const c = document.getElementById('zoneChip'); if (!c.hidden) window.__chip.push([S.odo, document.getElementById('zoneTxt').textContent]); }, 200); });
  await page.waitForTimeout(off ? 30000 : 52000);
  const r = await page.evaluate(() => { const S = window.__PL.S; return { zones: [...S.zones.values()], ev: window.__ev, chip: window.__chip, odo: S.odo, cams: S.cams.size }; });
  await page.close(); return { ...r, spoken };
}

// aperçu d'un itinéraire : la zone est comptée et dessinée sur la carte (avec MAPLIBRE_DIR), sans repère sur le radar
async function preview(browser, port, opt = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }), ML = process.env.MAPLIBRE_DIR; const qs = [];
  await page.route('**/*', r => { const u = r.request().url();
    if (u.startsWith(`http://localhost:${port}`)) return r.continue();
    const json = o => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: typeof o === 'string' ? o : JSON.stringify(o) });
    if (u.includes('/interpreter')) { const pd = decodeURIComponent((r.request().postData() || '').replace(/^data=/, '')); if (/speed_camera/.test(pd)) qs.push(pd); if (opt.fail) return r.fulfill({ status: 504, body: '' }); if (opt.far) return json({ elements: [{ type: 'node', id: 778, lat: LAT0 + 2000 * mLat, lon: LON0 + 35 * mLon, tags: { highway: 'speed_camera' } }, { type: 'node', id: 779, lat: LAT0 + 1000 * mLat, lon: LON0 + 400 * mLon, tags: { highway: 'speed_camera' } }] }); return json(overpass); }
    if (ML && u.includes('unpkg.com/maplibre-gl')) return r.fulfill({ status: 200, path: path.join(ML, path.basename(u)) });
    if (ML && u.includes('openfreemap.org/styles')) return json({ version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eee' } }] });
    if (u.includes('photon.komoot.io')) return json({ features: [{ geometry: { coordinates: [LON0, LAT0 + 2900 * mLat] }, properties: { name: 'Nord', city: 'Nantes' } }] });
    if (u.includes('router.project-osrm.org')) return json({ code: 'Ok', routes: [{ geometry: { coordinates: geo.map(g => [g.lon, g.lat]) }, distance: 3000, duration: 150 }] });
    return r.abort(); });
  await page.addInitScript(({ LAT0, LON0 }) => { navigator.geolocation.getCurrentPosition = ok => setTimeout(() => ok({ coords: { latitude: LAT0, longitude: LON0, accuracy: 5 } }), 5); navigator.geolocation.watchPosition = () => 1; }, { LAT0, LON0 });
  await page.goto(`http://localhost:${port}/`); await page.waitForTimeout(ML ? 2000 : 800);
  await page.fill('#qDest', 'Nord Nantes'); await page.waitForSelector('#destRes button'); await page.click('#destRes button'); await page.waitForTimeout(1500);
  const out = { count: await page.textContent('#zoneCount').catch(() => null), q: qs[0] || '' };
  if (ML) out.line = await page.evaluate(() => { const m = document.querySelector('.maplibregl-map') && window.__PL.MAP; if (!m) return null; const f = m.getSource('rzones')._data.features; return f.map(x => x.geometry.coordinates); });
  await page.close(); return out;
}

(async () => {
  const srv = await serve(), port = srv.address().port, browser = await chromium.launch();
  const pv = await preview(browser, port), pf = await preview(browser, port, { fail: true }), pd = await preview(browser, port, { far: true });
  let failed = 0; const check = (ok, msg) => { console.log((ok ? 'OK    ' : 'ÉCHEC ') + msg); if (!ok) failed++; };
  const a = await run(browser, port, false), b = await run(browser, port, true);
  await browser.close(); srv.close();
  const z = a.zones[0], cam = 2000 - 100; // radar à 1 900 m de distance parcourue depuis le départ
  console.log(z ? `Zone : de ${Math.round(z.start)} à ${Math.round(z.end)} m parcourus (radar vers ${cam} m), limite ${z.max}` : 'aucune zone');
  check(a.cams === 1 && z && Math.round(z.end - z.start) === 2000 && z.max === 80, 'radar lu dans OpenStreetMap, zone de 2 km sur route limitée à 80');
  check(z && z.start < cam - 300 && z.end > cam + 300, 'le radar est dans la zone, sans être près du début ni de la fin');
  check(a.ev && a.ev.vt === 80 && Math.abs(a.ev.odo + a.ev.d - z.start) < 20, `l'entrée de zone est un obstacle à 80 km/h (lever le pied avant d'entrer)`);
  check(a.chip.length > 5 && /^Zone de contrôle · 80 km\/h · encore /.test(a.chip[0][1]) && a.chip[0][0] >= z.start - 40, `pastille en zone : « ${a.chip.length ? a.chip[0][1] : '—'} »`);
  check(a.spoken.some(t => /Zone de contrôle\. Limitation à 80/.test(t)), 'annonce vocale à l’entrée de zone');
  check(b.chip.length === 0 && !b.spoken.some(t => /Zone de contrôle/.test(t)), 'réglage coupé : rien n’est annoncé');
  check(/^1 zone de contrôle sur le trajet/.test(pv.count || ''), `aperçu du trajet : « ${pv.count} »`);
  check(/node\(around:120,[-\d.,]+\)\[highway=speed_camera\]/.test(pv.q) && !/\(\d+\.\d+,-?\d+\.\d+,\d+\.\d+,-?\d+\.\d+\);out/.test(pv.q), `recherche dans une bande autour du trajet, pas dans tout le rectangle (${pv.q.length} caractères)`);
  check(/^1 zone de contrôle/.test(pd.count || ''), `radar posé à 35 m (autre chaussée) compté, radar d'une route voisine à 400 m ignoré (« ${pd.count} »)`);
  check(/indisponibles pour le moment/.test(pf.count || ''), `service des radars en panne : on le dit (« ${pf.count} »)`);
  if (pv.line !== undefined) { const L = pv.line && pv.line[0], lat = L ? L.map(c => (c[1] - LAT0) / mLat) : [];
    check(L && lat[0] > 1000 && lat[0] < 1700 && Math.round(lat[lat.length - 1]) === 3000, `zone dessinée sur la carte : de ${Math.round(lat[0])} m à la fin du trajet (3 000 m), radar à 2 000 m`); }
  console.log(failed ? `${failed} vérification(s) en échec` : 'RÉUSSI : zones de contrôle annoncées, sans position exacte des radars');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
