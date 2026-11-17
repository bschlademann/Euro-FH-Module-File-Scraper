import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_NAME = '.sync-manifest.json';

/**
 * Sanitiert Dateinamen (entfernt ungültige Zeichen)
 * @param {string} filename - Original Dateiname
 * @returns {string} Sanitierter Dateiname
 */
function sanitizeFilename(filename) {
  return filename
    .replace(/[<>:"|?*/\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lädt das Sync-Manifest aus dem Download-Verzeichnis.
 * Enthält pro Datei den remoteKey (uid + Dateiname) und den SHA-256 des Inhalts.
 * @param {string} downloadDir - Download-Verzeichnis
 * @param {{deepCheck?: boolean}} [options] - Optionen
 * @returns {Promise<Object>} Manifest-Helfer
 */
export async function loadSyncManifest(downloadDir, options = {}) {
  const manifestPath = path.join(downloadDir, MANIFEST_NAME);
  let data = { version: 1, files: {} };

  if (await fs.pathExists(manifestPath)) {
    try {
      const loaded = await fs.readJson(manifestPath);
      if (loaded && loaded.files && typeof loaded.files === 'object') data = loaded;
    } catch (error) {
      console.warn(`Sync-Manifest konnte nicht gelesen werden, starte neu: ${error.message}`);
    }
  }

  let dirty = false;
  const counts = { newFiles: 0, updated: 0, unchanged: 0, failed: 0 };

  return {
    deepCheck: options.deepCheck === true,
    counts,
    keyFor(filepath) {
      return path.relative(downloadDir, filepath).split(path.sep).join('/');
    },
    get(key) {
      return data.files[key] || null;
    },
    set(key, value) {
      data.files[key] = { ...value, checkedAt: new Date().toISOString() };
      dirty = true;
    },
    touch(key) {
      if (data.files[key]) {
        data.files[key].checkedAt = new Date().toISOString();
        dirty = true;
      }
    },
    record(kind) {
      if (kind in counts) counts[kind]++;
    },
    async save() {
      if (!dirty) return;
      await fs.writeJson(manifestPath, data, { spaces: 2 });
      dirty = false;
    }
  };
}

/**
 * Wandelt eine Viewer-URL (/studium/index/pdf?file=...) in die echte Download-URL um.
 * @param {string} url - Viewer- oder Download-URL
 * @returns {string} Download-URL
 */
export function resolveDownloadUrl(url) {
  if (url.includes('/studium/index/pdf?') && url.includes('file=')) {
    const fileMatch = url.match(/file=([^&]+)/);
    if (fileMatch) {
      try {
        return 'https://www.euro-fh-campus.de' + decodeURIComponent(fileMatch[1]);
      } catch (error) {
        console.warn(`Konnte file-Parameter nicht dekodieren: ${error.message}`);
      }
    }
  }
  return url;
}

/**
 * Baut einen stabilen Fingerprint aus der Download-URL.
 * Die Plattform vergibt bei einer neuen Version eine neue uid und einen neuen Dateinamen.
 * @param {string} downloadUrl - Download-URL
 * @returns {string} remoteKey
 */
function buildRemoteKey(downloadUrl) {
  try {
    const url = new URL(downloadUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    const filename = parts[parts.length - 1] || '';
    const uidIndex = parts.indexOf('uid');
    const uid = uidIndex >= 0 ? parts[uidIndex + 1] : '';
    return uid ? `${uid}|${filename}` : downloadUrl;
  } catch {
    return downloadUrl;
  }
}

/**
 * Berechnet den SHA-256 einer lokalen Datei (streamend, speicherschonend).
 * @param {string} filepath - Dateipfad
 * @returns {Promise<string>} Hex-Hash
 */
async function hashFile(filepath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filepath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

/**
 * Lädt eine PDF herunter und speichert sie nur, wenn sie neu oder geändert ist.
 * @param {string} url - Download URL
 * @param {string} filepath - Zielpath
 * @param {string} description - Beschreibung für Logging
 * @param {puppeteer.Page} [page] - Optional: Puppeteer Page um Cookies zu holen
 * @param {Object} [sync] - Optional: Manifest-Helfer aus loadSyncManifest()
 */
export async function downloadPdf(url, filepath, description = 'PDF', page = null, sync = null) {
  try {
    if (!url) {
      console.warn(`Keine URL für ${description} vorhanden`);
      sync?.record('failed');
      return false;
    }

    const downloadUrl = resolveDownloadUrl(url);
    const remoteKey = buildRemoteKey(downloadUrl);
    const key = sync ? sync.keyFor(filepath) : null;
    const entry = sync ? sync.get(key) : null;
    const fileExists = await fs.pathExists(filepath);

    // Gleiche Quelle und Datei vorhanden: kein Download nötig
    if (entry && fileExists && entry.remoteKey === remoteKey && !sync.deepCheck) {
      console.log(`Unverändert: ${description}`);
      sync.touch(key);
      sync.record('unchanged');
      return true;
    }

    await fs.ensureDir(path.dirname(filepath));

    // Hole Cookies von Puppeteer Page wenn vorhanden
    let cookieHeader = '';
    if (page) {
      try {
        const cookies = await page.cookies();
        if (cookies.length > 0) {
          cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        }
      } catch (error) {
        console.warn(`Konnte Cookies nicht abrufen: ${error.message}`);
      }
    }

    console.log(`Lade herunter: ${description}`);

    const response = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 60000,
      maxRedirects: 10,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/pdf, application/octet-stream, */*',
        'Referer': 'https://www.euro-fh-campus.de/',
        ...(cookieHeader && { 'Cookie': cookieHeader })
      }
    });

    const fileBuffer = response.data;

    // Validiere dass wir tatsächlich eine PDF haben
    let isPdf = false;
    if (fileBuffer && fileBuffer.length > 0) {
      if (fileBuffer.toString('ascii', 0, 4) === '%PDF') isPdf = true;
    }

    if (!isPdf && fileBuffer && fileBuffer.length > 0) {
      const contentStr = fileBuffer.toString('utf-8', 0, Math.min(500, fileBuffer.length));
      if (contentStr.includes('<html') || contentStr.includes('<!DOCTYPE') || contentStr.includes('<?xml')) {
        console.error(`${description}: Heruntergeladene Datei ist HTML, keine PDF!`);
        console.error(`   URL: ${url}`);
        console.error(`   Erste 200 Zeichen: ${contentStr.substring(0, 200)}`);
        sync?.record('failed');
        return false;
      }
    }

    const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const size = fileBuffer.length;

    if (entry && fileExists) {
      if (entry.sha256 === sha256) {
        console.log(`Unverändert (Inhalt identisch): ${description}`);
        sync.set(key, { remoteKey, sha256, size });
        sync.record('unchanged');
        return true;
      }
      console.log(`Neue Version erkannt: ${description}`);
    } else if (sync && fileExists) {
      // Bestandsdatei ohne Manifest-Eintrag: einmalig per Hash abgleichen
      const localHash = await hashFile(filepath);
      if (localHash === sha256) {
        console.log(`Unverändert (Baseline geprüft): ${description}`);
        sync.set(key, { remoteKey, sha256, size });
        sync.record('unchanged');
        return true;
      }
      console.log(`Neue Version erkannt (Baseline): ${description}`);
    }

    await fs.writeFile(filepath, fileBuffer);
    if (sync) {
      sync.set(key, { remoteKey, sha256, size });
      sync.record(fileExists ? 'updated' : 'newFiles');
    }
    console.log(`Gespeichert: ${description} (${(size / 1024).toFixed(2)} KB)`);
    return true;

  } catch (error) {
    console.error(`Download fehlgeschlagen (${description}):`, error.message);
    if (error.response) {
      console.error(`   HTTP Status: ${error.response.status}`);
    }
    sync?.record('failed');
    return false;
  }
}

/**
 * Erstellt die Ordnerstruktur und speichert alle Materialien
 * @param {Array} modules - Array mit Modulen
 * @param {puppeteer.Page} page - Authentifizierte Seite
 * @param {string} downloadDir - Basis-Download Verzeichnis
 */
export async function downloadAllMaterials(modules, page, downloadDir) {
  console.log('\nErstelle Ordnerstruktur und lade Materialien herunter...\n');

  let totalDownloaded = 0;
  let totalFailed = 0;

  for (const module of modules) {
    const moduleName = sanitizeFilename(module.title);
    const moduleDir = path.join(downloadDir, moduleName);
    
    console.log(`\nModul: ${moduleName}`);
    
    try {
      // Hole Lernmaterialien für dieses Modul
      const materials = await page.evaluate((moduleUrl) => {
        // Diese Funktion würde auf der Server-Seite ausgeführt werden
        // Hier eine vereinfachte Version
        return [];
      }, module.url);

      // Falls materials leer ist, versuche über die getLearningMaterials Funktion
      const { getLearningMaterials } = await import('./scraper.js').catch(() => ({}));
      
      if (getLearningMaterials) {
        const { materials } = await getLearningMaterials(page, module.id);
        
        for (const material of materials) {
          let materialName = sanitizeFilename(material.title);
          // Entferne "Studienheft" falls es noch irgendwie im Namen ist
          materialName = materialName.replace(/\s*Studienheft\s*/gi, '').trim();
          const materialDir = path.join(moduleDir, materialName);
          
          console.log(`  Lernheft: ${materialName}`);
          
          // Download Lernheft PDF
          if (material.pdfUrl) {
            const pdfPath = path.join(materialDir, `${materialName}.pdf`);
            const success = await downloadPdf(
              material.pdfUrl,
              pdfPath,
              `${moduleName}/${materialName}`
            );
            if (success) totalDownloaded++;
            else totalFailed++;
          }
          
          // Download Korrekturhinweise wenn vorhanden
          if (material.corrections && material.corrections.length > 0) {
            for (const correction of material.corrections) {
              // Extrahiere den Dateinamen aus dem Correction-Objekt
              let filename = correction.filename || 'Korrekturhinweis';
              // Bereinige den Dateinamen (entferne HTML-Tags und Extra-Text)
              filename = filename.replace(/<[^>]*>/g, '').replace(/\u00A0/g, ' ').trim();
              // Falls kein guter Name, nutze einen Default
              if (!filename || filename.length < 3) {
                filename = 'Korrekturhinweis.pdf';
              }
              
              const correctionPath = path.join(materialDir, filename);
              const fullUrl = correction.url.startsWith('http') 
                ? correction.url 
                : `https://www.euro-fh-campus.de${correction.url}`;
              const success = await downloadPdf(
                fullUrl,
                correctionPath,
                `${moduleName}/${materialName} (${filename})`
              );
              if (success) totalDownloaded++;
              else totalFailed++;
            }
          }
        }
      }
      
    } catch (error) {
      console.error(`  Fehler bei Modul ${moduleName}:`, error.message);
      totalFailed++;
    }
  }

  console.log('\n');
  console.log('═'.repeat(50));
  console.log(`Download abgeschlossen!`);
  console.log(`   Erfolgreich: ${totalDownloaded}`);
  console.log(`   Fehler: ${totalFailed}`);
  console.log('═'.repeat(50));
}

/**
 * Prüft die heruntergeladenen Dateien
 * @param {string} downloadDir - Download Verzeichnis
 * @param {Object} [expectedByModule] - Erwartete Studienhefte pro Modul (aus dem Scraping)
 */
export async function verifyDownloads(downloadDir, expectedByModule = {}) {
  console.log('\nÜberprüfe heruntergeladene Dateien...\n');

  let stats = {
    modules: 0,
    materials: 0,
    pdfs: 0,
    totalSize: 0
  };

  try {
    const modules = await fs.readdir(downloadDir);
    
    for (const moduleName of modules) {
      const modulePath = path.join(downloadDir, moduleName);
      const stat = await fs.stat(modulePath);
      
      if (stat.isDirectory()) {
        stats.modules++;
        console.log(`${moduleName}`);
        
        const materials = await fs.readdir(modulePath);
        
        for (const materialName of materials) {
          const materialPath = path.join(modulePath, materialName);
          const materialStat = await fs.stat(materialPath);
          
          if (materialStat.isDirectory()) {
            stats.materials++;
            const files = await fs.readdir(materialPath);
            const pdfFiles = files.filter(f => f.endsWith('.pdf'));
            stats.pdfs += pdfFiles.length;
            
            for (const pdfFile of pdfFiles) {
              const pdfPath = path.join(materialPath, pdfFile);
              const pdfStat = await fs.stat(pdfPath);
              stats.totalSize += pdfStat.size;
              console.log(`   ${materialName}/${pdfFile} (${(pdfStat.size / 1024 / 1024).toFixed(2)} MB)`);
            }
          }
        }
      }
    }
    
    console.log('\n' + '═'.repeat(50));
    console.log('Zusammenfassung:');
    console.log(`   Module: ${stats.modules}`);
    console.log(`   Lernhefte: ${stats.materials}`);
    console.log(`   PDFs: ${stats.pdfs}`);
    console.log(`   Gesamtgröße: ${(stats.totalSize / 1024 / 1024).toFixed(2)} MB`);
    console.log('═'.repeat(50));

    // Abgleich: erwartete Studienhefte (nach Titel) gegen Downloads
    const expectedModules = Object.entries(expectedByModule).filter(
      ([, expected]) => expected && expected.titles && expected.titles.length > 0
    );

    if (expectedModules.length > 0) {
      console.log('\nVollständigkeit (erwartete Studienhefte):');
      let missingTotal = 0;

      for (const [moduleName, expected] of expectedModules) {
        const modulePath = path.join(downloadDir, moduleName);

        if (!await fs.pathExists(modulePath)) {
          console.log(`  ${moduleName}: Modul-Ordner fehlt (erwartet: ${expected.titles.length} Studienhefte)`);
          missingTotal += expected.titles.length;
          continue;
        }

        const missing = [];
        for (const title of expected.titles) {
          const normalized = normalizeMaterialName(title);
          const folderPath = path.join(modulePath, normalized);

          if (!await fs.pathExists(folderPath)) {
            missing.push(title);
            continue;
          }

          // Haupt-PDF muss im Heft-Ordner liegen (nicht nur der Ordner existieren)
          const files = await fs.readdir(folderPath);
          if (!files.includes(`${normalized}.pdf`)) {
            missing.push(title);
          }
        }

        if (missing.length > 0) {
          missingTotal += missing.length;
          console.log(`  ${moduleName}: ${missing.length} von ${expected.titles.length} Studienheften fehlen:`);
          for (const title of missing) {
            console.log(`       - ${title}`);
          }
        } else {
          console.log(`  ${moduleName}: alle ${expected.titles.length} Studienhefte heruntergeladen`);
        }
      }

      if (missingTotal === 0) {
        console.log('\nAlle Studienhefte wurden vollständig heruntergeladen.');
      } else {
        console.log(`\n${missingTotal} Studienheft(e) fehlen.`);
      }
    }
    
  } catch (error) {
    console.error('Fehler beim Überprüfen der Downloads:', error.message);
  }
}

/**
 * Normalisiert einen Materialnamen so, wie er als Ordner angelegt wird
 * @param {string} name - Rohname (z.B. "ITMTH05 - IT-Sourcing und IT-Controlling")
 * @returns {string} Normalisierter Ordnername
 */
export function normalizeMaterialName(name) {
  return sanitizeFilename(name).replace(/\s*Studienheft\s*/gi, '').trim();
}
