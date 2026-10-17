// Copie les fichiers de l'appli web (à la racine du dépôt) dans www/, utilisé par l'appli Android.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), out = path.join(root, 'www');
const FILES = ['index.html', 'manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out);
for (const f of FILES) fs.copyFileSync(path.join(root, f), path.join(out, f));
// Bibliothèque Capacitor (accès aux modules natifs : voix, écran allumé, GPS en arrière-plan),
// ajoutée seulement dans la version de l'appli Android
fs.copyFileSync(path.join(root, 'node_modules/@capacitor/core/dist/capacitor.js'), path.join(out, 'capacitor.js'));
const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
const marker = '<script>\n(() => {';
if (!html.includes(marker)) throw new Error("index.html : script principal introuvable");
let page = html.replace(marker, '<script src="capacitor.js"></script>\n' + marker);
// Démarrage plus rapide de l'appli Android : bibliothèque de carte embarquée (pas d'attente réseau)
// et polices chargées sans bloquer le démarrage
for (const f of ['maplibre-gl.js', 'maplibre-gl.css']) fs.copyFileSync(path.join(root, 'node_modules/maplibre-gl/dist', f), path.join(out, f));
const ML = 'https://unpkg.com/maplibre-gl@4.7.1/dist/';
if (!page.includes(ML + 'maplibre-gl.js') || !page.includes(ML + 'maplibre-gl.css')) throw new Error('index.html : liens maplibre introuvables');
page = page.split(ML).join('');
page = page.replace(/<link href="(https:\/\/fonts\.googleapis\.com\/css2[^"]*)" rel="stylesheet">/, '<link href="$1" rel="stylesheet" media="print" onload="this.media=\'all\'">');
fs.writeFileSync(path.join(out, 'index.html'), page);
// Numéro de version de l'appli Android (fourni par GitHub), pour savoir si une version plus récente existe
const code = parseInt(process.env.VERSION_CODE || '0', 10);
fs.writeFileSync(path.join(out, 'app-version.json'), JSON.stringify({ code }));
console.log(`www/ prêt (${FILES.length} fichiers, version ${code || 'non numérotée'})`);
