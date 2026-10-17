// Test : en simulation, l'étiquette « Lever le pied ici » et la zone orange restent-elles stables ?
// Route droite de 3 km avec un ralentisseur tous les 500 m : la voiture simulée accélère, lève le pied,
// ralentit, passe le ralentisseur, réaccélère… Image par image, on vérifie que l'étiquette ne clignote pas,
// ne bouge pas sur la carte, et que la zone orange ne s'allonge ni ne se raccourcit en boucle.
// Lancement : node tests/repere-stable.test.cjs   (dossier de l'appli en argument, par défaut le dépôt)
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
        if (f.endsWith('.html')) b = b.toString().replace(/\}\)\(\);\s*<\/script>\s*<\/body>/, 'window.__PL={get S(){return S},SIM,start};})();</script></body>');
        rsp.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); rsp.end(b); });
    }).listen(0, () => res(s));
  });
}

(async () => {
  const srv = await serve(), port = srv.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith(`http://localhost:${port}`)) return r.continue();
    if (u.includes('/interpreter')) return r.fulfill({ status: 200, contentType: 'application/json', body: overpass });
    return r.abort();
  });
  await page.addInitScript(() => { try { speechSynthesis.speak = () => {}; } catch (e) {} });
  await page.goto(`http://localhost:${port}/`);
  await page.waitForTimeout(800);
  // départ au milieu de la route
  await page.evaluate(({ lat, lon }) => { window.__PL.start('sim', { at: { lat, lon, name: 'test' } }); window.__PL.SIM.mult = 4; }, { lat: LAT0 + 1500 * mLat, lon: LON0 });
  await page.evaluate(() => {
    window.__rec = [];
    const loop = t => { const S = window.__PL.S, L = S.liftShown, Z = S.zoneShown;
      __rec.push([t, S.v, L ? L[0] : null, L ? L[1] : null, Z ? Z[0][0] : null, Z ? Z[0][1] : null, Z ? Z[1][0] : null, Z ? Z[1][1] : null]);
      requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  await page.waitForTimeout(25000);
  const rec = await page.evaluate(() => __rec), dist = await page.evaluate(() => window.__PL.S.log.dist);
  await browser.close(); srv.close();

  // On compte, image par image : apparitions/disparitions, déplacements de l'étiquette, changements de la zone.
  let lBlink = 0, zBlink = 0, lJump = 0, zJump = 0, lN = 0, zN = 0, vMin = 99, vMax = 0;
  for (let i = 1; i < rec.length; i++) { const a = rec[i - 1], b = rec[i];
    vMin = Math.min(vMin, b[1]); vMax = Math.max(vMax, b[1]);
    if ((a[2] == null) !== (b[2] == null)) lBlink++;
    if ((a[4] == null) !== (b[4] == null)) zBlink++;
    if (a[2] != null && b[2] != null) { lN++; const d = Math.hypot(b[2] - a[2], b[3] - a[3]); if (d < 100) lJump = Math.max(lJump, d); } // > 100 m : étiquette de l'obstacle suivant
    if (a[4] != null && b[4] != null) { zN++; const d1 = Math.hypot(b[4] - a[4], b[5] - a[5]), d2 = Math.hypot(b[6] - a[6], b[7] - a[7]); if (d1 < 100 && d2 < 100) zJump = Math.max(zJump, d1, d2); } }
  const passes = Math.floor(dist / 500) + 1; // ralentisseurs croisés (un tous les 500 m)
  console.log(`Distance simulée : ${Math.round(dist)} m · images : ${rec.length} · vitesse simulée de ${Math.round(vMin * 3.6)} à ${Math.round(vMax * 3.6)} km/h`);
  console.log(`Étiquette « Lever le pied ici » : affichée ${lN} images, ${lBlink} apparitions/disparitions, plus grand saut ${lJump.toFixed(2)} m`);
  console.log(`Zone orange : affichée ${zN} images, ${zBlink} apparitions/disparitions, plus grand changement ${zJump.toFixed(2)} m`);
  // Une apparition et une disparition par ralentisseur passé, pas plus ; aucun déplacement.
  const ok = lN > 60 && zN > 60 && vMax - vMin > 3 && lBlink <= 2 * passes + 2 && zBlink <= 2 * passes + 2 && lJump < 0.5 && zJump < 0.5;
  console.log(ok ? 'RÉUSSI : l\'étiquette et la zone orange restent stables' : 'ÉCHEC : l\'étiquette ou la zone orange clignote, bouge ou change de longueur');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
