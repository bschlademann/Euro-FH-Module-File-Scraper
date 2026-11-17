import puppeteer from 'puppeteer';
import fs from 'fs-extra';
import path from 'path';
import dotenv from 'dotenv';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { login, logout, isLoggedIn } from './auth.js';
import { getModules, getLearningMaterials, collectHeftIds } from './scraper.js';
import { downloadAllMaterials, downloadPdf, verifyDownloads, findMissingMaterials } from './downloader.js';

dotenv.config();

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
 * CLI Eingabe
 */
function getInput(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Prüfe ob Dateien bereits im Download-Verzeichnis existieren
 * @param {Array} modules - Array von Modulen mit ihren Materialien
 * @param {string} downloadDir - Basis-Download Verzeichnis
 * @returns {Promise<{pdfCount: number, totalFiles: number, moduleDirs: number}>} Gefundene Dateien
 */
async function checkExistingFiles(modules, downloadDir) {
  let pdfCount = 0;
  let totalFiles = 0;
  let moduleDirs = 0;

  for (const module of modules) {
    const moduleNameWithCode = module.code ? `${module.code} - ${module.title}` : module.title;
    const moduleName = sanitizeFilename(moduleNameWithCode);
    const moduleDir = path.join(downloadDir, moduleName);

    // Prüfe ob Modul-Verzeichnis existiert
    if (await fs.pathExists(moduleDir)) {
      moduleDirs++;
      // Rekursiv zählen: die PDFs liegen in den Heft-Ordnern, nicht direkt im Modulordner
      const entries = await fs.readdir(moduleDir, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        totalFiles++;
        if (entry.name.toLowerCase().endsWith('.pdf')) pdfCount++;
      }
    }
  }

  return { pdfCount, totalFiles, moduleDirs };
}

/**
 * Hauptprogramm
 */
async function main() {
  let browser;
  let page;

  try {
    console.log('╔═══════════════════════════════════╗');
    console.log('║  Euro-FH Scraper v1.0.0           ║');
    console.log('║  Automatisches Download-Tool      ║');
    console.log('╚═══════════════════════════════════╝\n');

    // Browser starten
    console.log('Starte Browser...');
    browser = await puppeteer.launch({
      headless: process.env.HEADLESS !== 'false',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    // Login
    page = await login(browser);
    
    // Prüfe ob Login erfolgreich war
    if (!await isLoggedIn(page)) {
      throw new Error('Login fehlgeschlagen. Bitte überprüfe deine Credentials in der .env Datei');
    }

    // Hole alle Module
    const modules = await getModules(page);
    
    if (modules.length === 0) {
      console.log('Keine Module gefunden!');
      return;
    }

    // Zeige Module an
    console.log('\nVerfügbare Module:\n');
    modules.forEach((mod, index) => {
      console.log(`  ${index + 1}. ${mod.title} ${mod.code ? `(${mod.code})` : ''}`);
    });

    // Stelle sicher dass Verzeichnis existiert
    const downloadDir = path.join(projectRoot, 'euro-fh-module-scraper-downloads');
    await fs.ensureDir(downloadDir);

    // Prüfe ob bereits Dateien existieren
    const existing = await checkExistingFiles(modules, downloadDir);

    // Frage IMMER nach dem Modus
    let duplicateHandling = 'overwrite'; // default
    console.log('\nDownload-Modus:');

    if (existing.pdfCount > 0) {
      console.log(`${existing.pdfCount} PDF(s) in ${existing.moduleDirs} Modulordner(n) gefunden ` +
        `(inkl. Korrekturhinweisen; ${existing.totalFiles} Dateien insgesamt).`);
    }

    let validChoice = false;
    while (!validChoice) {
      const modePrompt = existing.pdfCount > 0 
        ? 'Was möchtest du tun?\n  1. Überschreiben\n  2. Überspringen\nWahl (1 oder 2): '
        : 'Wie sollen existierende Dateien behandelt werden?\n  1. Überschreiben (wenn später vorhanden)\n  2. Überspringen (wenn später vorhanden)\nWahl (1 oder 2): ';
      
      const modeChoice = await getInput(modePrompt);
      
      if (modeChoice.trim() === '1') {
        duplicateHandling = 'overwrite';
        console.log('Modus: Dateien werden überschrieben\n');
        validChoice = true;
      } else if (modeChoice.trim() === '2') {
        duplicateHandling = 'skip';
        console.log('Modus: Existierende Dateien werden übersprungen\n');
        validChoice = true;
      } else {
        console.log('Ungültige Eingabe. Bitte 1 oder 2 eingeben.\n');
      }
    }

    // Lade alle Materialien herunter
    console.log('Dies kann einige Zeit dauern...\n');

    // Erwartete Studienhefte pro Modul (für den Abgleich nach dem Download)
    const expectedByModule = {};

    // Für jedes Modul: Hole Lernmaterialien und speichere
    for (const module of modules) {
      // Erstelle Modulname mit Code: "MD ALGO - Algorithmen und Datenstrukturen"
      const moduleNameWithCode = module.code ? `${module.code} - ${module.title}` : module.title;
      const moduleName = sanitizeFilename(moduleNameWithCode);
      const moduleDir = path.join(downloadDir, moduleName);
      
      console.log(`\nModul: ${moduleName}`);
      
      try {
        // Pre-Scan: Hefte aus dem DOM lesen (schnell, öffnet das Modul NICHT)
        const collected = await collectHeftIds(page, module.id);
        expectedByModule[moduleName] = {
          studienhefte: collected.studienhefte,
          titles: collected.titles
        };

        // Festplatten-Check: welche Hefte sind bereits vollständig vorhanden?
        let skipIds = null;
        if (duplicateHandling === 'skip') {
          const allTitles = Array.from(new Set(
            Object.values(collected.titleById).filter(t => t)
          ));
          const missingTitles = await findMissingMaterials(moduleDir, allTitles);

          skipIds = new Set(
            Object.entries(collected.titleById)
              .filter(([, title]) => title && !missingTitles.includes(title))
              .map(([id]) => id)
          );

          if (skipIds.size > 0 && skipIds.size === collected.ids.length) {
            console.log(`  Modul vollständig, überspringe (${collected.ids.length} Lernhefte vorhanden)`);
            continue;
          }
        }

        const { materials } = await getLearningMaterials(page, module.id, skipIds);
        
        for (const material of materials) {
          let materialName = sanitizeFilename(material.title);
          // Entferne "Studienheft" falls es noch irgendwie im Namen ist
          materialName = materialName.replace(/\s*Studienheft\s*/gi, '').trim();
          const materialDir = path.join(moduleDir, materialName);
          
          console.log(`  Lernheft: ${materialName}`);
          if (material._debug) {
            console.log(`     ${material._debug}`);
          }
          
          // Download PDF (nutze Page für authentifizierte Cookies)
          if (material.pdfUrl) {
            const pdfPath = path.join(materialDir, `${materialName}.pdf`);
            console.log(`     URL: ${material.pdfUrl}`);
            await downloadPdf(material.pdfUrl, pdfPath, `${moduleName}/${materialName}`, page, duplicateHandling);
          }
          
          // Download Korrekturhinweise wenn vorhanden
          if (material.corrections && material.corrections.length > 0) {
            for (const correction of material.corrections) {
              // Extrahiere den Dateinamen aus dem Correction-Objekt
              let filename = correction.filename || 'Korrekturhinweis';
              // Bereinige den Dateinamen (entferne HTML-Tags und Extra-Text)
              filename = filename.replace(/<[^>]*>/g, '').trim();
              // Extrahiere nur den PDF-Dateinamen
              const pdfMatch = filename.match(/[\w\s\-\.]+\.pdf$/i);
              if (pdfMatch) {
                filename = pdfMatch[0];
              } else if (!filename.endsWith('.pdf')) {
                filename += '.pdf';
              }
              
              const correctionPath = path.join(materialDir, filename);
              const fullUrl = correction.url.startsWith('http') 
                ? correction.url 
                : `https://www.euro-fh-campus.de${correction.url}`;
              await downloadPdf(fullUrl, correctionPath, `${moduleName}/${materialName} (${filename})`, page, duplicateHandling);
            }
          }
        }
      } catch (error) {
        console.error(`  Fehler bei Modul ${moduleName}:`, error.message);
      }
    }

    // Zeige Zusammenfassung
    await verifyDownloads(downloadDir, expectedByModule);
    
  } catch (error) {
    console.error('\nFEHLER:', error.message);
    console.error('\nLösungsvorschläge:');
    console.error('1. Überprüfe deine Credentials in der .env Datei');
    console.error('2. Stelle sicher dass dein Account Zugriff auf die Materialien hat');
    console.error('3. Prüfe deine Internetverbindung');
    
  } finally {
    // Cleanup
    if (page) {
      try {
        await logout(page);
      } catch (error) {
        console.warn('Logout konnte nicht durchgeführt werden');
      }
    }
    
    if (browser) {
      await browser.close();
    }
  }
}

// Starte Programm
main().catch(error => {
  console.error('Fatal Error:', error);
  process.exit(1);
});
