// Test : Plein Malin — où faire le plein sur l'itinéraire, avec le gain net (détour compris).
// Trajet droit de 20 km vers le nord ; 5 stations (prix du gazole) : A 1,85 € à 1 km, E 1,80 € à 5 km, B 1,70 € à 10 km
// (500 m à côté), C 1,40 € mais à 6 km de la route (ignorée), D 1,80 € à 18 km. Prix médian du trajet : 1,80 €.
// Gain attendu pour B sur 40 L : (1,80 − 1,70) × 40 − détour (1,6 km à 6,5 L/100 × 1,70 €) = 3,82 €.
// Lancement : node tests/plein.test.cjs   (dossier de l'appli en argument, par défaut le dépôt)
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const DIR = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const LAT0 = 47.2184, LON0 = -1.5536, mLat = 1 / 111320, mLon = 1 / (111320 * Math.cos(LAT0 * Math.PI / 180));
const at = (d, off) => ({ lat: LAT0 + d * mLat, lon: LON0 + off * mLon });
const ST = [['A', 1000, 200, 1.85, 'Orvault'], ['E', 5000, 300, 1.80, 'Sautron'], ['B', 10000, 500, 1.70, 'Vigneux'], ['C', 15000, 6000, 1.40, 'Loin'], ['D', 18000, 100, 1.80, 'Blain']]
  .map(([id, d, off, p, v]) => ({ id, ...at(d, off), p, v }));
const route = []; for (let d = 0; d <= 20000; d += 100) { const q = at(d, 0); route.push([q.lon, q.lat]); }
const geo = []; for (let d = 0; d <= 20000; d += 50) geo.push(at(d, 0));
const overpass = JSON.stringify({ elements: [{ type: 'way', id: 1, nodes: geo.map((_, i) => 1000 + i), geometry: geo, tags: { highway: 'primary', maxspeed: '80' } }] });

function serve() { return new Promise(res => { const s = http.createServer((req, rsp) => {
  const f = path.join(DIR, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  fs.readFile(f, (e, b) => { if (e) { rsp.writeHead(404); return rsp.end(); }
    if (f.endsWith('.html')) b = b.toString().replace(/\}\)\(\);\s*<\/script>\s*<\/body>/, 'window.__PL={get S(){return S}};})();</script></body>');
    rsp.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); rsp.end(b); }); }).listen(0, () => res(s)); }); }

(async () => {
  const srv = await serve(), port = srv.address().port, browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); const spoken = [], asked = [];
  await page.exposeFunction('__spoke', t => spoken.push(t));
  let failed = 0; const check = (ok, msg) => { console.log((ok ? 'OK    ' : 'ÉCHEC ') + msg); if (!ok) failed++; };
  await page.route('**/*', r => { const u = r.request().url();
    if (u.startsWith(`http://localhost:${port}`)) return r.continue();
    const json = o => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: typeof o === 'string' ? o : JSON.stringify(o) });
    if (u.includes('/interpreter')) { const pd = r.request().postData() || ''; return json(/speed_camera/.test(decodeURIComponent(pd)) ? { elements: [] } : overpass); }
    if (u.includes('photon.komoot.io')) return json({ features: [{ geometry: { coordinates: route[route.length - 1] }, properties: { name: 'Blain', city: 'Blain' } }] });
    if (u.includes('router.project-osrm.org')) return json({ code: 'Ok', routes: [{ geometry: { coordinates: route }, distance: 20000, duration: 900 }] });
    if (u.includes('prix-des-carburants')) { const q = new URL(u); asked.push(q.searchParams.get('where'));
      return json({ total_count: ST.length, results: Number(q.searchParams.get('offset')) > 0 ? [] : ST.map(s => ({ id: s.id, geom: { lat: s.lat, lon: s.lon }, adresse: 'Station ' + s.id, ville: s.v, gazole_prix: s.p })) }); }
    return r.abort(); });
  await page.addInitScript(({ LAT0, LON0, mLat }) => {
    localStorage.setItem('pl-fuel', 'gazole');
    navigator.geolocation.getCurrentPosition = ok => setTimeout(() => ok({ coords: { latitude: LAT0, longitude: LON0, accuracy: 5 } }), 5);
    navigator.geolocation.watchPosition = ok => { const tick = () => { ok({ coords: { latitude: LAT0 + 7000 * mLat, longitude: LON0, accuracy: 5, speed: 20, heading: 0 }, timestamp: Date.now() }); setTimeout(tick, 1000); }; tick(); return 1; };
    navigator.geolocation.clearWatch = () => {}; try { speechSynthesis.speak = u => window.__spoke(u.text); } catch (e) {} }, { LAT0, LON0, mLat });
  await page.goto(`http://localhost:${port}/`); await page.waitForTimeout(600);
  await page.fill('#qDest', 'Blain'); await page.waitForSelector('#destRes button'); await page.click('#destRes button'); await page.waitForTimeout(1500);
  const line = await page.textContent('#pleinLine');
  check(asked.length >= 1 && /within_distance\(geom, geom'POINT\(/.test(asked[0]) && / OR /.test(asked[0]), `prix demandés le long du trajet (${asked.length} requête(s))`);
  check(/Plein Malin : Vigneux à (9,9|10,0) km · 1,700 € · −3,82 € sur un plein de 40 L/.test(line), `aperçu : « ${line} »`);
  await page.click('#pleinLine'); await page.waitForTimeout(300);
  const items = await page.$$eval('#fuelList .fst', b => b.map(x => x.innerText.replace(/\s+/g, ' ')));
  check(await page.textContent('#fuelHead') === 'Plein Malin' && items.length === 3 && /Station B/.test(items[0]) && /−3,82 €/.test(items[0]) && !items.some(t => /Station C/.test(t)), `fiche Plein Malin : ${items.map(t => t.slice(0, 40)).join(' | ')}`);
  await page.click('#fuelTank button:nth-of-type(5)'); await page.waitForTimeout(200);
  const items60 = await page.$$eval('#fuelList .fst', b => b.map(x => x.innerText.replace(/\s+/g, ' ')));
  check(/−5,82 €/.test(items60[0]), `plein de 60 L : gain recalculé (${(items60[0].match(/−[\d,]+ €/) || [''])[0]})`);
  await page.click('#bFuelClose');
  await page.click('#bReal'); await page.waitForTimeout(5000);
  const chip = await page.evaluate(() => { const c = document.getElementById('pleinChip'); return c.hidden ? null : document.getElementById('pleinTxt').textContent; });
  check(chip && /^Plein Malin dans 3,0 km · 1,700 €/.test(chip), `en roulant, 3 km avant : « ${chip} »`);
  check(spoken.some(t => /Plein Malin/.test(t)), `annonce vocale (« ${spoken.find(t => /Plein Malin/.test(t)) || '—'} »)`);
  await browser.close(); srv.close();
  console.log(failed ? `${failed} vérification(s) en échec` : 'RÉUSSI : Plein Malin trouve le meilleur plein sur le trajet');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
