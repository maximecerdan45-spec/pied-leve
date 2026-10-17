// Test : l'appli se met-elle à jour toute seule quand une nouvelle version est publiée ?
// 1. Sur l'écran d'accueil : elle doit se recharger d'elle-même.
// 2. En plein trajet : elle ne doit PAS se recharger, mais l'annoncer ;
//    la mise à jour se fait quand on revient à l'accueil après le bilan.
// Lancement : node tests/mise-a-jour.test.cjs
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');

const SRC = path.join(__dirname, '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pied-leve-'));
for (const f of fs.readdirSync(SRC)) if (fs.statSync(path.join(SRC, f)).isFile()) fs.copyFileSync(path.join(SRC, f), path.join(DIR, f));
const publish = n => fs.appendFileSync(path.join(DIR, 'index.html'), `\n<!-- version ${n} -->\n`);

const srv = http.createServer((req, rsp) => {
  const f = path.join(DIR, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  fs.readFile(f, (e, b) => { if (e) { rsp.writeHead(404); return rsp.end(); }
    rsp.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); rsp.end(b); });
});

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'OK   ' : 'ÉCHEC'} ${msg}`); if (!ok) failed++; };
const returnToApp = page => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

(async () => {
  await new Promise(r => srv.listen(0, r)); const url = `http://localhost:${srv.address().port}/`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.route('**/*', r => r.request().url().startsWith(url) ? r.continue() : r.abort());
  await page.addInitScript(() => { navigator.geolocation.watchPosition = () => 1; navigator.geolocation.clearWatch = () => {}; try { speechSynthesis.speak = () => {}; } catch (e) {} });
  let loads = 0; page.on('load', () => loads++);

  // 1. Écran d'accueil
  await page.goto(url); await page.waitForTimeout(1000);
  await returnToApp(page); await page.waitForTimeout(800);
  check(loads === 1, 'pas de rechargement tant que rien n\'a changé');
  publish(1); await returnToApp(page); await page.waitForTimeout(1500);
  check(loads === 2, 'nouvelle version publiée : l\'appli se recharge toute seule sur l\'accueil');

  // 2. En plein trajet
  await page.waitForTimeout(800);
  await page.click('#bReal'); await page.waitForTimeout(300);
  publish(2); await returnToApp(page); await page.waitForTimeout(1500);
  check(loads === 2, 'en plein trajet : pas de rechargement');
  check(await page.isVisible('#updBtn'), 'en plein trajet : la nouvelle version est annoncée');
  await page.click('#bEnd'); await page.waitForTimeout(500);
  check(loads === 2 && await page.isVisible('#ovEnd'), 'fin du trajet : le bilan reste affiché');
  await page.click('#bAgain'); await page.waitForTimeout(1500);
  check(loads === 3, '« Nouveau trajet » : la nouvelle version s\'installe');

  await browser.close(); srv.close(); fs.rmSync(DIR, { recursive: true, force: true });
  console.log(failed ? `${failed} vérification(s) en échec` : 'RÉUSSI : l\'appli se met à jour toute seule');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
