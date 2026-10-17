// Test : l'appli se met-elle à jour toute seule quand une nouvelle version est publiée ?
// 1. Sur l'écran d'accueil : elle doit se recharger d'elle-même.
// 2. En plein trajet : elle ne doit PAS se recharger, mais l'annoncer ;
//    la mise à jour se fait quand on revient à l'accueil après le bilan.
// 3. Appli Android : elle propose de télécharger la nouvelle version (jamais en plein trajet).
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

  // 3. Appli Android : elle ne se recharge pas, elle propose de télécharger la nouvelle version
  fs.writeFileSync(path.join(DIR, 'app-version.json'), JSON.stringify({ code: 5 }));
  let latest = 5, apkAsked = 0;
  const app = await browser.newPage();
  await app.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, Plugins: {} };
    navigator.geolocation.watchPosition = () => 1; navigator.geolocation.clearWatch = () => {}; });
  await app.route('**/*', r => { const u = r.request().url();
    if (u.startsWith(url)) return r.continue();
    if (u.startsWith('https://api.github.com/repos/maximecerdan45-spec/pied-leve/releases/tags/android-latest'))
      return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ name: `Pied Levé Android (version ${latest})`, assets: [{ name: 'PiedLeve.apk', browser_download_url: 'https://github.com/maximecerdan45-spec/pied-leve/releases/download/android-latest/PiedLeve.apk' }] }) });
    if (u.endsWith('/PiedLeve.apk')) { apkAsked++; return r.fulfill({ status: 200, contentType: 'text/plain', body: 'apk' }); }
    return r.abort(); });
  await app.goto(url); await app.waitForTimeout(1000);
  check(!(await app.isVisible('#updBtn')), 'appli Android à jour : aucun message');
  latest = 6; await returnToApp(app); await app.waitForTimeout(800);
  check(await app.isVisible('#updBtn') && /toucher pour l’installer/.test(await app.textContent('#updBtn')), 'appli Android : nouvelle version proposée sur l\'accueil');
  await app.click('#bReal'); await app.waitForTimeout(300); await returnToApp(app); await app.waitForTimeout(800);
  check(/après le trajet/.test(await app.textContent('#updBtn')), 'appli Android en plein trajet : installation repoussée après le trajet');
  await app.click('#updBtn'); await app.waitForTimeout(500);
  check(apkAsked === 0, 'appli Android en plein trajet : toucher le message ne lance rien');
  await app.click('#bEnd'); await app.waitForTimeout(300); await app.click('#bAgain'); await app.waitForTimeout(300);
  check(/toucher pour l’installer/.test(await app.textContent('#updBtn')), 'appli Android après le trajet : installation proposée');
  await app.click('#updBtn'); await app.waitForTimeout(800);
  check(apkAsked === 1, 'appli Android : toucher le message télécharge la nouvelle version');

  await browser.close(); srv.close(); fs.rmSync(DIR, { recursive: true, force: true });
  console.log(failed ? `${failed} vérification(s) en échec` : 'RÉUSSI : l\'appli se met à jour toute seule');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
