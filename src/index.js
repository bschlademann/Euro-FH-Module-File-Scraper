import puppeteer from 'puppeteer';
import fs from 'fs-extra';
import path from 'path';
import dotenv from 'dotenv';
import readline from 'readline';
import { login, logout, isLoggedIn } from './auth.js';
import { getModules, getLearningMaterials } from './scraper.js';
import { downloadAllMaterials, downloadPdf, verifyDownloads } from './downloader.js';

dotenv.config();

/**
 * Sanitiert Dateinamen (entfernt ungültige Zeichen)
 * @param {string} filename - Original Dateiname
 * @returns {string} Sanitierter Dateiname
 */
function sanitizeFilename(filename) {
  return filename
    .replace(/[<>:"|?*]/g, '')
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
 * Hauptprogramm
 */
async function main() {
  let browser;
  let page;

  try {
    console.log('╔═══════════════════════════════════╗');
    console.log('║  Euro-FH Scraper v1.0.0          ║');
    console.log('║  Automatisches Download-Tool      ║');
    console.log('╚═══════════════════════════════════╝\n');

    // Browser starten
    console.log('🚀 Starte Browser...');
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
      console.log('⚠️ Keine Module gefunden!');
      return;
    }

    // Zeige Module an
    console.log('\n📚 Verfügbare Module:\n');
    modules.forEach((mod, index) => {
      console.log(`  ${index + 1}. ${mod.title} ${mod.code ? `(${mod.code})` : ''}`);
    });

    // Frage nach Download bestätigung
    const downloadDir = process.env.DOWNLOAD_DIR || './downloads';
    const confirm = await getInput(`\n📁 Downloads speichern in: ${path.resolve(downloadDir)}\nFortfahren? (ja/nein): `);
    
    if (confirm.toLowerCase() !== 'ja' && confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
      console.log('❌ Download abgebrochen');
      return;
    }

    // Stelle sicher dass Verzeichnis existiert
    await fs.ensureDir(downloadDir);

    // Lade alle Materialien herunter
    console.log('\n⏳ Dies kann einige Zeit dauern...\n');
    
    // Für jedes Modul: Hole Lernmaterialien und speichere
    for (const module of modules) {
      // Erstelle Modulname mit Code: "MD ALGO - Algorithmen und Datenstrukturen"
      const moduleNameWithCode = module.code ? `${module.code} - ${module.title}` : module.title;
      const moduleName = sanitizeFilename(moduleNameWithCode);
      const moduleDir = path.join(downloadDir, moduleName);
      
      console.log(`\n📂 Modul: ${moduleName}`);
      
      try {
        const materials = await getLearningMaterials(page, module.id);
        
        for (const material of materials) {
          let materialName = sanitizeFilename(material.title);
          // Entferne "Studienheft" falls es noch irgendwie im Namen ist
          materialName = materialName.replace(/\s*Studienheft\s*/gi, '').trim();
          const materialDir = path.join(moduleDir, materialName);
          
          console.log(`  📄 Lernheft: ${materialName}`);
          if (material._debug) {
            console.log(`     ${material._debug}`);
          }
          
          // Download PDF (nutze Page für authentifizierte Cookies)
          if (material.pdfUrl) {
            const pdfPath = path.join(materialDir, `${materialName}.pdf`);
            console.log(`     URL: ${material.pdfUrl}`);
            await downloadPdf(material.pdfUrl, pdfPath, `${moduleName}/${materialName}`, page);
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
              await downloadPdf(fullUrl, correctionPath, `${moduleName}/${materialName} (${filename})`, page);
            }
          }
        }
      } catch (error) {
        console.error(`  ❌ Fehler bei Modul ${moduleName}:`, error.message);
      }
    }

    // Zeige Zusammenfassung
    await verifyDownloads(downloadDir);
    
  } catch (error) {
    console.error('\n❌ FEHLER:', error.message);
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
        console.warn('⚠️ Logout konnte nicht durchgeführt werden');
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
