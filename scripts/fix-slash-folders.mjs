import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const downloadDir = process.argv[2] || path.join(__dirname, '..', 'downloads');

function sanitizeFilename(filename) {
  return filename
    .replace(/[<>:"|?*/\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function walk(dir, base, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, out);
    } else if (entry.isFile()) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

// 1) Beschädigte Materialien finden.
// Eine durch "/" (Pfad-Trenner) kaputte Struktur sieht so aus:
//   <moduleDir>/seg1/seg2/.../segN/seg1/seg2/.../seg(N-1)/segN.pdf
// Das Haupt-PDF liegt also verschachtelt, seine Verzeichnis-Segmente (relativ
// zum Modulordner) haben ungerade Länge L = 2N-1 und wiederholen die ersten N.
const broken = [];

for (const entry of fs.readdirSync(downloadDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const modulePath = path.join(downloadDir, entry.name);

  for (const rel of walk(modulePath, modulePath)) {
    const parts = rel.split(path.sep);
    const filename = parts.pop();
    const L = parts.length;

    if (L < 3 || L % 2 === 0) continue;

    const N = (L + 1) / 2;
    const first = parts.slice(0, N);
    const rest = parts.slice(N);
    if (!rest.every((d, i) => d === first[i])) continue;
    if (filename !== `${first[N - 1]}.pdf`) continue;

    const materialName = first.join('/');
    const newName = sanitizeFilename(materialName);
    if (newName.includes('/') || newName.includes('\\')) continue;

    broken.push({
      modulePath,
      materialName,
      newName
    });
  }
}

const seen = new Set();
const materials = broken.filter(m => {
  const key = `${m.modulePath}|${m.materialName}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

console.log(`Gefunden: ${materials.length} beschädigte Lernheft-Ordner\n`);

// 2) Migrieren
let moved = 0;
for (const m of materials) {
  const segments = m.materialName.split('/');
  const N = segments.length;
  const materialFolder = path.join(m.modulePath, ...segments);
  const newFolder = path.join(m.modulePath, m.newName);
  fs.ensureDirSync(newFolder);

  for (const rel of walk(materialFolder, materialFolder)) {
    const parts = rel.split(path.sep);
    const filename = parts.pop();
    const dirs = parts.filter(p => p !== '.');

    // Haupt-PDF: liegt in <moduleDir>/seg1/.../seg(N-1>/segN.pdf
    const isMainPdf =
      dirs.length === N - 1 &&
      dirs.every((d, i) => d === segments[i]) &&
      filename === `${segments[N - 1]}.pdf`;

    const target = isMainPdf
      ? path.join(newFolder, `${m.newName}.pdf`)
      : path.join(newFolder, filename);

    fs.moveSync(path.join(materialFolder, rel), target, { overwrite: true });
    moved++;
    console.log(`  ✔ ${m.materialName} → ${path.relative(downloadDir, target)}`);
  }

  // Alte Struktur entfernen, danach leere Eltern-Ordner aufräumen
  fs.removeSync(materialFolder);
  let parent = path.dirname(materialFolder);
  while (parent !== m.modulePath) {
    if (fs.readdirSync(parent).length === 0) fs.removeSync(parent);
    else break;
    parent = path.dirname(parent);
  }
}

console.log(`\nFertig: ${moved} Dateien verschoben, ${materials.length} Ordner repariert.`);
