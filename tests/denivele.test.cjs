// Test : le dénivelé est-il pris en compte pour le point « lever le pied » ?
// Route droite avec un ralentisseur (30 km/h) à 1300 m ; relief simulé (faux service d'altitude Open-Meteo) :
// plat, descente de 3 % vers l'obstacle, montée de 3 %. En descente la voiture ralentit moins en roue libre :
// il faut lever le pied plus tôt ; en montée, plus tard. On vérifie aussi qu'un pont au-dessus d'un ravin
// n'est pas pris pour une descente suivie d'une montée.
// Lancement : node tests/denivele.test.cjs   (dossier de l'appli en argument, par défaut le dépôt)
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const DIR = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const LAT0 = 47.2184, LON0 = -1.5536, V = 13.9; // 50 km/h
const mLat = 1 / 111320;
const N = 251; const geo = []; for (let i = 0; i < N; i++) geo.push({ lat: LAT0 + i * 10 * mLat, lon: LON0 });
const BUMP = 130; // 1300 m
function overpass(bridge) {
  const els = [];
  if (bridge) { // ravin de 900 à 1000 m, franchi par un pont
    els.push({ type: 'way', id: 1, nodes: geo.slice(0, 91).map((_, i) => 1000 + i), geometry: geo.slice(0, 91), tags: { highway: 'primary', maxspeed: '50' } });
    els.push({ type: 'way', id: 2, nodes: geo.slice(90, 101).map((_, i) => 1090 + i), geometry: geo.slice(90, 101), tags: { highway: 'primary', maxspeed: '50', bridge: 'yes' } });
    els.push({ type: 'way', id: 3, nodes: geo.slice(100).map((_, i) => 1100 + i), geometry: geo.slice(100), tags: { highway: 'primary', maxspeed: '50' } });
  } else els.push({ type: 'way', id: 1, nodes: geo.map((_, i) => 1000 + i), geometry: geo, tags: { highway: 'primary', maxspeed: '50' } });
  els.push({ type: 'node', id: 1000 + BUMP, lat: geo[BUMP].lat, lon: geo[BUMP].lon, tags: { traffic_calming: 'bump' } });
  return JSON.stringify({ elements: els });
}
// altitude du terrain : pente constante le long de la route (vers le nord), plus un ravin de 25 m sous le pont
const ground = (lat, grade, ravine) => { const d = (lat - LAT0) / mLat; let h = 100 + grade * d; if (ravine && d > 905 && d < 995) h -= 25 * Math.sin(Math.PI * (d - 905) / 90); return h; };

function serve() {
  return new Promise(res => {
    const s = http.createServer((req, rsp) => {
      const f = path.join(DIR, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
      fs.readFile(f, (e, b) => { if (e) { rsp.writeHead(404); return rsp.end(); }
        if (f.endsWith('.html')) b = b.toString().replace(/\}\)\(\);\s*<\/script>\s*<\/body>/, 'window.__PL={get S(){return S},coastDist};})();</script></body>');
        rsp.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); rsp.end(b); });
    }).listen(0, () => res(s));
  });
}

async function run(browser, port, grade, opt = {}) {
  const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
  const asked = { n: 0, bad: 0 };
  await page.route('**/*', r => { const u = r.request().url();
    if (u.startsWith(`http://localhost:${port}`)) return r.continue();
    if (u.includes('/interpreter')) return r.fulfill({ status: 200, contentType: 'application/json', body: overpass(opt.bridge) });
    if (u.includes('api.open-meteo.com/v1/elevation')) { asked.n++;
      if (opt.noElev) return r.fulfill({ status: 503, body: '' });
      const q = new URL(u).searchParams, la = q.get('latitude').split(',').map(Number), lo = q.get('longitude').split(',').map(Number);
      if (la.length !== 100 || lo.length !== 100) asked.bad++;
      return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ elevation: la.map(x => +ground(x, grade, opt.bridge).toFixed(1)) }) }); }
    return r.abort(); });
  await page.addInitScript(({ LAT0, LON0, mLat, V }) => {
    const fix = s => ({ coords: { latitude: LAT0 + s * mLat, longitude: LON0, accuracy: 5, speed: V, heading: 0 }, timestamp: Date.now() });
    navigator.geolocation.watchPosition = ok => { const t0 = performance.now(); const tick = () => { ok(fix(400 + V * (performance.now() - t0) / 1000)); setTimeout(tick, 1000); }; tick(); return 1; };
    navigator.geolocation.clearWatch = () => {};
    try { speechSynthesis.speak = () => {}; } catch (e) {}
  }, { LAT0, LON0, mLat, V });
  await page.goto(`http://localhost:${port}/`); await page.waitForTimeout(800);
  await page.click('#bReal'); await page.waitForTimeout(9000);
  const r = await page.evaluate(() => { const S = window.__PL.S, k = Object.keys(S.liftRef).find(k => k[0] === 'c'), P = S.path;
    return { lift: k ? S.liftRef[k] : null, el: k ? !!S.liftEl[k] : false, grMin: P && P.gr ? Math.min(...P.gr) : null, grMax: P && P.gr ? Math.max(...P.gr) : null }; });
  await page.close();
  return { ...r, asked };
}

(async () => {
  const srv = await serve(), port = srv.address().port, browser = await chromium.launch();
  let failed = 0; const check = (ok, msg) => { console.log((ok ? 'OK    ' : 'ÉCHEC ') + msg); if (!ok) failed++; };
  const flat = await run(browser, port, 0), down = await run(browser, port, -0.03), up = await run(browser, port, 0.03);
  const bridge = await run(browser, port, 0, { bridge: true }), none = await run(browser, port, -0.03, { noElev: true });
  await browser.close(); srv.close();
  console.log(`Lever le pied avant le ralentisseur : plat ${flat.lift} m, descente 3 % ${down.lift} m, montée 3 % ${up.lift} m, pont sur ravin ${bridge.lift} m, relief indisponible ${none.lift} m`);
  check(flat.asked.n > 0 && flat.asked.bad === 0, `altitudes demandées par carreaux de 100 points (${flat.asked.n} demandes)`);
  check(down.el && up.el && flat.el, 'le relief est bien utilisé pour le calcul');
  check(flat.lift >= 110 && flat.lift <= 160, `terrain plat : environ 130 m (${flat.lift} m)`);
  check(down.lift >= flat.lift * 1.8, `en descente, on lève le pied bien plus tôt (${down.lift} m)`);
  check(up.lift <= flat.lift * 0.8 && up.lift >= 50, `en montée, plus tard (${up.lift} m)`);
  check(Math.abs(bridge.lift - flat.lift) <= 10 && bridge.grMin > -0.01, `pont au-dessus d'un ravin : la route reste plate (${bridge.lift} m, pente mini ${(bridge.grMin * 100).toFixed(1)} %)`);
  check(none.lift === flat.lift, 'sans le service d’altitude : calcul sur terrain plat, rien ne casse');
  console.log(failed ? `${failed} vérification(s) en échec` : 'RÉUSSI : le dénivelé est pris en compte');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
