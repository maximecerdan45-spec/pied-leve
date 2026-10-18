// Test : départ guidé et carte libre pendant le trajet.
// 1) Voiture à l'arrêt (pas de cap GPS) au milieu d'une route nord-sud, itinéraire vers le sud :
//    le tracé vert devant doit partir vers le sud (le sens de l'itinéraire), et suivre l'itinéraire.
// 2) Avec la vraie carte (MAPLIBRE_DIR=<dist de maplibre-gl 4.7.1>) : faire glisser la carte la détache de la voiture,
//    le bouton « Recentrer » apparaît, et le toucher revient à la voiture.
// Lancement : node tests/navigation.test.cjs   (dossier de l'appli en argument, par défaut le dépôt)
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const DIR = path.resolve(process.argv[2] || path.join(__dirname, '..')), ML = process.env.MAPLIBRE_DIR;
const LAT0 = 47.2184, LON0 = -1.5536, mLat = 1 / 111320;
const geo = []; for (let i = 0; i < 301; i++) geo.push({ lat: LAT0 + (i - 150) * 10 * mLat, lon: LON0 });
const overpass = JSON.stringify({ elements: [{ type: 'way', id: 1, nodes: geo.map((_, i) => 1000 + i), geometry: geo, tags: { highway: 'primary', maxspeed: '50' } }] });
const STYLE = JSON.stringify({ version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eee' } }] });
const DEST = { lat: LAT0 - 1400 * mLat, lon: LON0 };

function serve() { return new Promise(res => { const s = http.createServer((req, rsp) => {
  const f = path.join(DIR, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  fs.readFile(f, (e, b) => { if (e) { rsp.writeHead(404); return rsp.end(); }
    if (f.endsWith('.html')) b = b.toString().replace(/\}\)\(\);\s*<\/script>\s*<\/body>/, 'window.__PL={get S(){return S},get CAM(){return CAM},get GL(){return GL},get MAP(){return MAP}};})();</script></body>');
    rsp.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); rsp.end(b); }); }).listen(0, () => res(s)); }); }

(async () => {
  const srv = await serve(), port = srv.address().port, browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let failed = 0; const check = (ok, msg) => { console.log((ok ? 'OK    ' : 'ÉCHEC ') + msg); if (!ok) failed++; };
  await page.route('**/*', r => { const u = r.request().url();
    if (u.startsWith(`http://localhost:${port}`)) return r.continue();
    const json = o => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: typeof o === 'string' ? o : JSON.stringify(o) });
    if (u.includes('/interpreter')) return json(overpass);
    if (ML && u.includes('unpkg.com/maplibre-gl')) return r.fulfill({ status: 200, path: path.join(ML, path.basename(u)) });
    if (ML && u.includes('openfreemap.org/styles')) return json(STYLE);
    if (u.includes('photon.komoot.io')) return json({ features: [{ geometry: { coordinates: [DEST.lon, DEST.lat] }, properties: { name: 'Sud', city: 'Nantes' } }] });
    if (u.includes('router.project-osrm.org')) return json({ code: 'Ok', routes: [{ geometry: { coordinates: geo.slice(0, 151).reverse().map(g => [g.lon, g.lat]) }, distance: 1500, duration: 120 }] });
    return r.abort(); });
  await page.addInitScript(({ LAT0, LON0 }) => {
    const fix = () => ({ coords: { latitude: LAT0, longitude: LON0, accuracy: 5, speed: 0, heading: null }, timestamp: Date.now() });
    navigator.geolocation.getCurrentPosition = ok => setTimeout(() => ok(fix()), 5);
    navigator.geolocation.watchPosition = ok => { const tick = () => { ok(fix()); setTimeout(tick, 1000); }; tick(); return 1; };
    navigator.geolocation.clearWatch = () => {}; try { speechSynthesis.speak = () => {}; } catch (e) {} }, { LAT0, LON0 });
  await page.goto(`http://localhost:${port}/`); await page.waitForTimeout(800);
  await page.fill('#qDest', 'Sud Nantes'); await page.waitForSelector('#destRes button'); await page.click('#destRes button'); await page.waitForTimeout(600);
  await page.click('#bReal'); await page.waitForTimeout(5000);
  const p = await page.evaluate(() => { const S = window.__PL.S, P = S.path; return P && { y0: P.pts[0][1], y1: P.pts[P.pts.length - 1][1], len: P.len, on: S.onRoute }; });
  check(p && p.on, 'la voiture est reconnue sur l’itinéraire');
  check(p && p.y1 < p.y0 - 500, `à l'arrêt, le tracé devant part dans le sens de l'itinéraire (vers le sud, ${p ? Math.round(p.y1 - p.y0) : '?'} m)`);
  if (ML) {
    check(await page.evaluate(() => window.__PL.GL), 'carte MapLibre chargée');
    const c0 = await page.evaluate(() => window.__PL.MAP.getCenter().toArray());
    await page.mouse.move(195, 600); await page.mouse.down(); await page.mouse.move(195, 420, { steps: 8 }); await page.mouse.move(120, 300, { steps: 8 }); await page.mouse.up();
    await page.waitForTimeout(1500);
    const st = await page.evaluate(() => ({ free: window.__PL.CAM.free, c: window.__PL.MAP.getCenter().toArray(), btn: !document.getElementById('bRecenter').hidden }));
    check(st.free && st.btn, 'faire glisser la carte la détache de la voiture et affiche « Recentrer »');
    check(Math.hypot(st.c[0] - c0[0], st.c[1] - c0[1]) > 1e-4, 'la carte reste là où on l’a déplacée');
    const z0 = await page.evaluate(() => window.__PL.MAP.getZoom()); await page.click('#bZoomOut'); await page.click('#bZoomOut'); await page.waitForTimeout(700);
    const z1 = await page.evaluate(() => window.__PL.MAP.getZoom());
    check(z1 < z0 - 0.8, `on peut dézoomer en carte libre (zoom ${z0.toFixed(1)} → ${z1.toFixed(1)})`);
    await page.click('#bRecenter'); await page.waitForTimeout(800);
    const back = await page.evaluate(() => ({ free: window.__PL.CAM.free, btn: !document.getElementById('bRecenter').hidden }));
    check(!back.free && !back.btn, '« Recentrer » revient à la voiture');
  } else console.log('(carte libre non testée : MAPLIBRE_DIR non fourni)');
  await browser.close(); srv.close();
  console.log(failed ? `${failed} vérification(s) en échec` : 'RÉUSSI : départ dans le bon sens, carte libre et recentrage');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
