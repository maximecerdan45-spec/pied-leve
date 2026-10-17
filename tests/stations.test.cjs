// Test : bouton « stations-service » pendant un trajet simulé (route droite vers le nord).
// Fausses réponses : flux des prix (4 stations, 2 devant, 1 derrière, 1 sur le côté) et OpenStreetMap (noms).
// On vérifie : 3 stations proposées, celles de devant d'abord, avec le prix du carburant choisi.
// Lancement : node tests/stations.test.cjs   (dossier de l'appli en argument, par défaut le dépôt)
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const DIR = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const LAT0 = 47.2184, LON0 = -1.5536;
const mLat = 1 / 111320, mLon = 1 / (111320 * Math.cos(LAT0 * Math.PI / 180));
const N = 301; // un point tous les 10 m
const nodes = [], ways = [];
for (let i = 0; i < N; i++) nodes.push({ id: 1000 + i, lat: LAT0 + i * 10 * mLat, lon: LON0 });
const els = [{ type: 'way', id: 1, nodes: nodes.map(n => n.id), geometry: nodes.map(n => ({ lat: n.lat, lon: n.lon })), tags: { highway: 'primary', maxspeed: '50' } }];
for (let i = 50; i < N; i += 50) els.push({ type: 'node', id: 1000 + i, lat: nodes[i].lat, lon: nodes[i].lon, tags: { traffic_calming: 'bump' } });
const overpass = JSON.stringify({ elements: els });

function serve() {
  return new Promise(res => {
    const s = http.createServer((req, rsp) => {
      const f = path.join(DIR, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
      fs.readFile(f, (e, b) => { if (e) { rsp.writeHead(404); return rsp.end(); }
        if (f.endsWith('.html')) b = b.toString().replace(/\}\)\(\);\s*<\/script>\s*<\/body>/, 'window.__PL={get S(){return S},SIM,start,bubbleInfo};})();</script></body>');
        rsp.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); rsp.end(b); });
    }).listen(0, () => res(s));
  });
}

(async () => {
  const srv = await serve(), port = srv.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
  const at = (dn, de) => ({ lat: LAT0 + (1500 + dn) * mLat, lon: LON0 + de * mLat / Math.cos(LAT0 * Math.PI / 180) });
  const S1 = at(600, 20), S2 = at(1800, -30), S3 = at(-300, 0), S4 = at(0, 900);
  const gov = { results: [
    { adresse: '12 route de Nantes', ville: 'Testville', geom: S1, gazole_prix: 1.789, e10_prix: 1.859 },
    { adresse: '3 avenue du Nord', ville: 'Testville', geom: S2, gazole_prix: 1.699, e10_prix: 1.799 },
    { adresse: '1 rue du Sud', ville: 'Testville', geom: S3, gazole_prix: 1.659, e10_prix: 1.759 },
    { adresse: 'Zone Est', ville: 'Testville', geom: S4, gazole_prix: 1.729, e10_prix: 1.829 }] };
  const osmFuel = { elements: [{ type: 'node', id: 9, lat: S1.lat, lon: S1.lon, tags: { amenity: 'fuel', brand: 'TotalEnergies' } }] };
  await page.route('**/*', r => { const u = decodeURIComponent(r.request().url());
    if (u.startsWith(`http://localhost:${port}`)) return r.continue();
    if (u.includes('data.economie.gouv.fr')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(gov) });
    if (u.includes('/interpreter') && u.includes('amenity=fuel')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(osmFuel) });
    if (u.includes('/interpreter')) return r.fulfill({ status: 200, contentType: 'application/json', body: overpass });
    return r.abort(); });
  await page.addInitScript(() => { try { speechSynthesis.speak = () => {}; } catch (e) {} });
  let failed = 0; const check = (ok, msg) => { console.log((ok ? 'OK    ' : 'ÉCHEC ') + msg); if (!ok) failed++; };
  await page.goto(`http://localhost:${port}/`); await page.waitForTimeout(800);
  await page.evaluate(({ lat, lon }) => { window.__PL.start('sim', { at: { lat, lon, name: 'test' } }); window.__PL.SIM.mult = 2; }, { lat: LAT0 + 1500 * mLat, lon: LON0 });
  await page.waitForTimeout(5000);
  check(await page.isVisible('#bFuel'), 'pendant le trajet : le bouton stations-service est visible');
  await page.click('#bFuel'); await page.waitForTimeout(1500);
  const rows = await page.$$eval('#fuelList .fst', bs => bs.map(b => b.innerText.replace(/\s+/g, ' ')));
  console.log('      ' + rows.join('\n      '));
  check(rows.length === 3, 'trois stations proposées');
  const north = await page.evaluate(() => window.__PL.S.veh && Math.cos(window.__PL.S.veh.h) > 0);
  const first = north ? 'TotalEnergies' : 'rue du Sud';
  check(rows[0] && rows[0].includes(first) && /devant/.test(rows[0]), `la plus proche devant vient en premier (${first})`);
  check(rows[0] && /1,789 €|1,659 €/.test(rows[0]) && /Gazole/.test(rows[0]), 'avec le prix du gazole');
  await page.click('#fuelKinds button:has-text("SP95-E10")'); await page.waitForTimeout(200);
  check(/1,859 €|1,759 €/.test(await page.textContent('#fuelList .fst')), 'changer de carburant change le prix affiché');
  await page.click('#bFuelClose'); await page.waitForTimeout(200);
  check(await page.isHidden('#ovFuel'), 'la fenêtre se ferme');
  await browser.close(); srv.close();
  console.log(failed ? `${failed} vérification(s) en échec` : 'RÉUSSI : les stations-service les plus utiles sont proposées avec leur prix');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
