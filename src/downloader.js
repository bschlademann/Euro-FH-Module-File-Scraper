import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
 * Lädt eine PDF herunter und speichert sie
 * @param {string} url - Download URL
 * @param {string} filepath - Zielpath
 * @param {string} description - Beschreibung für Logging
 * @param {puppeteer.Page} page - Optional: Puppeteer Page um Cookies zu holen
 * @param {string} duplicateHandling - 'overwrite' oder 'skip'
 */
export async function downloadPdf(url, filepath, description = 'PDF', page = null, duplicateHandling = 'overwrite') {
  try {
    if (!url) {
      console.warn(`⚠️ Keine URL für ${description} vorhanden`);
      return false;
    }

    // Prüfe ob Datei bereits existiert
    const fileExists = await fs.pathExists(filepath);
    if (fileExists) {
      if (duplicateHandling === 'skip') {
        console.log(`⏭️ Übersprungen (existiert bereits): ${description}`);
        return true;
      }
    }

    // Stelle sicher dass Verzeichnis existiert
    const dir = path.dirname(filepath);
    await fs.ensureDir(dir);

    console.log(`⬇️ Lade herunter: ${description}`);

    // Hole Cookies von Puppeteer Page wenn vorhanden
    let cookieHeader = '';
    if (page) {
      try {
        const cookies = await page.cookies();
        if (cookies.length > 0) {
          cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        }
      } catch (e) {
        console.warn(`⚠️ Konnte Cookies nicht abrufen: ${e.message}`);
      }
    }

    // WICHTIG: URLs von /studium/index/pdf sind Viewer, nicht direkter Download
    // Wir müssen den echten Download-Link aus dem 'file' Parameter extrahieren
    let downloadUrl = url;
    
    if (url.includes('/studium/index/pdf?') && url.includes('file=')) {
      // Extrahiere den file-Parameter und dekodiere ihn
      const fileMatch = url.match(/file=([^&]+)/);
      if (fileMatch) {
        try {
          const encodedFile = fileMatch[1];
          const decodedFile = decodeURIComponent(encodedFile);
          downloadUrl = 'https://www.euro-fh-campus.de' + decodedFile;
          console.log(`   📝 Konvertiere Viewer-URL zu Download-URL`);
        } catch (e) {
          console.warn(`⚠️ Konnte file-Parameter nicht dekodieren: ${e.message}`);
        }
      }
    }

    // Nutze axios zum Download (besser für binäre Dateien)
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
      // Prüfe auf PDF Signatur (%PDF-)
      if (fileBuffer.toString('ascii', 0, 4) === '%PDF') {
        isPdf = true;
      }
    }

    if (!isPdf && fileBuffer && fileBuffer.length > 0) {
      // Prüfe ob es HTML ist (häufig bei Fehlern)
      const contentStr = fileBuffer.toString('utf-8', 0, Math.min(500, fileBuffer.length));
      if (contentStr.includes('<html') || contentStr.includes('<!DOCTYPE') || contentStr.includes('<?xml')) {
        console.error(`❌ ${description}: Heruntergeladene Datei ist HTML, keine PDF!`);
        console.error(`   URL: ${url}`);
        console.error(`   Erste 200 Zeichen: ${contentStr.substring(0, 200)}`);
        return false;
      }
    }

    await fs.writeFile(filepath, fileBuffer);
    const fileSizeKb = (fileBuffer.length / 1024).toFixed(2);
    console.log(`✅ Gespeichert: ${description} (${fileSizeKb} KB)`);
    return true;

  } catch (error) {
    console.error(`❌ Download fehlgeschlagen (${description}):`, error.message);
    if (error.response) {
      console.error(`   HTTP Status: ${error.response.status}`);
    }
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
  console.log('\n📁 Erstelle Ordnerstruktur und lade Materialien herunter...\n');

  let totalDownloaded = 0;
  let totalFailed = 0;

  for (const module of modules) {
    const moduleName = sanitizeFilename(module.title);
    const moduleDir = path.join(downloadDir, moduleName);
    
    console.log(`\n📂 Modul: ${moduleName}`);
    
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
        const materials = await getLearningMaterials(page, module.url);
        
        for (const material of materials) {
          let materialName = sanitizeFilename(material.title);
          // Entferne "Studienheft" falls es noch irgendwie im Namen ist
          materialName = materialName.replace(/\s*Studienheft\s*/gi, '').trim();
          const materialDir = path.join(moduleDir, materialName);
          
          console.log(`  📄 Lernheft: ${materialName}`);
          
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
              filename = filename.replace(/<[^>]*>/g, '').trim();
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
      console.error(`  ❌ Fehler bei Modul ${moduleName}:`, error.message);
      totalFailed++;
    }
  }

  console.log('\n');
  console.log('═'.repeat(50));
  console.log(`✅ Download abgeschlossen!`);
  console.log(`   Erfolgreich: ${totalDownloaded}`);
  console.log(`   Fehler: ${totalFailed}`);
  console.log('═'.repeat(50));
}

/**
 * Prüft die heruntergeladenen Dateien
 * @param {string} downloadDir - Download Verzeichnis
 */
export async function verifyDownloads(downloadDir) {
  console.log('\n📊 Überprüfe heruntergeladene Dateien...\n');

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
        console.log(`📂 ${moduleName}`);
        
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
              console.log(`   📄 ${materialName}/${pdfFile} (${(pdfStat.size / 1024 / 1024).toFixed(2)} MB)`);
            }
          }
        }
      }
    }
    
    console.log('\n' + '═'.repeat(50));
    console.log('📊 Zusammenfassung:');
    console.log(`   Module: ${stats.modules}`);
    console.log(`   Lernhefte: ${stats.materials}`);
    console.log(`   PDFs: ${stats.pdfs}`);
    console.log(`   Gesamtgröße: ${(stats.totalSize / 1024 / 1024).toFixed(2)} MB`);
    console.log('═'.repeat(50));
    
  } catch (error) {
    console.error('❌ Fehler beim Überprüfen der Downloads:', error.message);
  }
}
