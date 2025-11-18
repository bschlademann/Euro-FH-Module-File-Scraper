import puppeteer from 'puppeteer';

/**
 * Holt alle verfügbaren Module
 * @param {puppeteer.Page} page - Authentifizierte Seite
 * @returns {Promise<Array>} Array mit Modulen
 */
export async function getModules(page) {
  console.log('📚 Lade alle Module...');
  
  try {
    // Navigiere zur Modulübersicht
    await page.goto('https://www.euro-fh-campus.de/studiumneu/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    console.log('⏳ Suche nach Modulen auf der Seite...');
    
    // Warte auf Module zu laden
    try {
      await page.waitForSelector('div.modulebox', { timeout: 15000 });
    } catch (e) {
      console.warn('⚠️ Module nicht gefunden, versuche verzögerte Suche...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Extrahiere Module Info mit evaluate
    const modules = await page.evaluate(() => {
      const moduleList = [];
      
      // Suche nach allen Modul-Boxen
      const moduleBoxes = document.querySelectorAll('div.modulebox[id^="mdl_"]');
      
      moduleBoxes.forEach((box) => {
        try {
          // Hole Modul-ID
          const moduleId = box.getAttribute('id').replace('mdl_', '');
          
          // Hole Modul-Titel und Code
          const titleElement = box.querySelector('.box.cols strong');
          if (!titleElement) return;
          
          const fullText = titleElement.innerText || titleElement.textContent;
          const titleMatch = fullText.split('\n')[0].trim();
          
          // Hole Modul-Code (in dfn Tag)
          const codeElement = box.querySelector('.box.cols dfn');
          const moduleCode = codeElement ? codeElement.innerText.trim() : '';
          
          if (titleMatch) {
            moduleList.push({
              title: titleMatch,
              code: moduleCode,
              id: moduleId,
              url: `https://www.euro-fh-campus.de/studiumneu/?module=${moduleId}`,
              domElement: box // Wird später für Expansion genutzt
            });
          }
        } catch (e) {
          console.error('Fehler beim Parsen von Modul:', e.message);
        }
      });

      return moduleList.map(m => ({
        title: m.title,
        code: m.code,
        id: m.id,
        url: m.url
      }));
    });

    if (modules.length === 0) {
      console.warn('⚠️ Keine Module gefunden!');
      console.log('📋 Seite HTML wird angezeigt für Debugging...');
    }

    console.log(`✅ ${modules.length} Module gefunden!`);
    return modules;
    
  } catch (error) {
    console.error('❌ Fehler beim Abrufen der Module:', error.message);
    throw error;
  }
}

/**
 * Holt alle Lernhefte eines Moduls
 * @param {puppeteer.Page} page - Authentifizierte Seite
 * @param {string} moduleId - ID des Moduls (mdl_*)
 * @returns {Promise<Array>} Array mit Lernheften
 */
export async function getLearningMaterials(page, moduleId) {
  console.log(`📖 Lade Lernmaterialien für Modul ${moduleId}...`);
  
  try {
    // Stelle sicher dass wir auf der richtigen Seite sind
    const currentUrl = page.url();
    if (!currentUrl.includes('studiumneu')) {
      await page.goto('https://www.euro-fh-campus.de/studiumneu/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
    }

    // Schritt 1: Expandiere das Modul
    console.log(`  ⏳ Expandiere Modul...`);
    await page.evaluate((modId) => {
      const moduleBox = document.querySelector(`div.modulebox[id="mdl_${modId}"]`);
      if (!moduleBox) return false;

      // Klicke auf listtrigger um zu expandieren
      const listTrigger = moduleBox.querySelector('.listtrigger');
      if (listTrigger && !moduleBox.classList.contains('open')) {
        listTrigger.click();
      }
      return true;
    }, moduleId);

    // Warte kurz damit die Liste expandiert
    await new Promise(resolve => setTimeout(resolve, 500));

    // Schritt 2: Finde alle Lernhefte und klicke sie um PDFs zu laden
    console.log(`  ⏳ Suche Lernhefte...`);
    
    const materials = [];
    
    // Hole alle Lernhefte IDs
    const hefteIds = await page.evaluate((modId) => {
      const moduleBox = document.querySelector(`div.modulebox[id="mdl_${modId}"]`);
      if (!moduleBox) return [];
      
      const moduleList = moduleBox.querySelector('.modulelist');
      if (!moduleList) return [];
      
      const hefteElements = moduleList.querySelectorAll('div.lerneinheit.heft[id^="le_"]');
      return Array.from(hefteElements).map(el => el.getAttribute('id')).filter(id => id && id !== 'le_');
    }, moduleId);

    console.log(`  📖 Gefundene Lernhefte: ${hefteIds.length}`);

    // Schritt 3: Für jedes Lernheft - klicke es und hole PDFs
    for (const heftId of hefteIds) {
      try {
        // Klicke auf das Lernheft um die Downloads anzuzeigen
        console.log(`    ⏳ Verarbeite ${heftId}...`);
        await page.evaluate((id) => {
          const element = document.getElementById(id);
          if (element) {
            // Klicke auf den Titel um das Element zu expandieren
            const titleLink = element.querySelector('.cell.title');
            if (titleLink) {
              titleLink.click();
            } else {
              element.click();
            }
          }
        }, heftId);

        // Warte länger damit die Tab-Inhalte mit PDFs geladen werden
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Extrahiere die PDF-Link für dieses Heft
        const heftMaterial = await page.evaluate((id, modId) => {
          const element = document.getElementById(id);
          if (!element) return null;

          // Hole Titel: GDI01 - Einführung in die Informatik
          const titleElement = element.querySelector('.cell.title strong.title-id');
          const dfnElement = element.querySelector('.cell.title dfn dfn');
          
          if (!titleElement) return null;

          // Extrahiere GDI01 aus strong.title-id
          // HTML-Struktur: <strong class="title-id">GDI01<em>Studienheft</em></strong>
          // Wir wollen nur "GDI01" haben
          let titleId = '';
          for (let node of titleElement.childNodes) {
            if (node.nodeType === 3) { // TEXT_NODE
              titleId += node.textContent.trim();
            }
          }
          // Falls childNodes nicht funktioniert, fallback
          if (!titleId) {
            titleId = (titleElement.innerText || titleElement.textContent).trim();
            // Entferne "Studienheft" wenn es enthalten ist
            titleId = titleId.replace(/\s+studienheft\s*/gi, '').trim();
          }
          
          // Extrahiere "Einführung in die Informatik" aus der dfn
          let fullTitle = titleId;
          if (dfnElement) {
            const dfnText = (dfnElement.innerText || dfnElement.textContent).trim();
            if (dfnText && dfnText.length > 0) {
              fullTitle = `${titleId} - ${dfnText}`;
            }
          }

          // WICHTIG: PDF-Links sind im Editor-Container (assignment_content_*)
          // nicht direkt im Lerneinheit-Element
          
          let pdfUrl = null;
          let foundVia = '';
          
          // Hole die Leid (learning element id) aus dem id
          const leid = id.replace('le_', '');
          const editorId = `assignment_content_${leid}`;
          const editor = document.getElementById(editorId);
          
          // Strategie 1: Suche im Editor nach PDF-Link
          if (editor) {
            const pdfLink = editor.querySelector('a.pdf[href*="/studium/index/pdf"]');
            if (pdfLink) {
              pdfUrl = pdfLink.getAttribute('href');
              foundVia = `editor(${editorId}) a.pdf`;
            }
          }
          
          // Strategie 2: Suche im Lerneinheit-Element selbst
          if (!pdfUrl) {
            const pdfLink = element.querySelector('a.pdf[href*="/studium/index/pdf"]');
            if (pdfLink) {
              pdfUrl = pdfLink.getAttribute('href');
              foundVia = 'lerneinheit a.pdf';
            }
          }
          
          // Strategie 3: Alle a.pdf Links
          if (!pdfUrl) {
            const allPdfLinks = element.querySelectorAll('a.pdf');
            if (allPdfLinks.length > 0) {
              pdfUrl = allPdfLinks[0].getAttribute('href');
              foundVia = 'first a.pdf in lerneinheit';
            }
          }

          // Prüfe auch auf Korrekturhinweise / Aktualisierungen in den verfügbaren Tabs
          let corrections = [];
          const allLinks = element.querySelectorAll('a');
          allLinks.forEach(link => {
            const href = link.getAttribute('href');
            const text = (link.innerText || link.textContent).trim();
            // Suche nach Links zu /download/index/aktualisierung/
            if (href && href.includes('/download/index/aktualisierung/')) {
              corrections.push({
                url: href,
                filename: text // Der Link-Text enthält meist den Dateinamen
              });
            }
          });

          if (fullTitle && pdfUrl) {
            // Stelle sicher dass die URL absolut ist
            let fullUrl = pdfUrl;
            if (!fullUrl.startsWith('http')) {
              fullUrl = 'https://www.euro-fh-campus.de' + (fullUrl.startsWith('/') ? '' : '/') + fullUrl;
            }
            
            return {
              title: fullTitle,
              pdfUrl: fullUrl,
              corrections: corrections.length > 0 ? corrections : [],
              _debug: `Found via: ${foundVia}, Original: ${pdfUrl}`
            };
          }
          
          return null;
        }, heftId, moduleId);

        // Wenn keine Korrekturhinweise gefunden wurden, klicke auf den Aktualisierungen-Tab
        if (heftMaterial && (!heftMaterial.corrections || heftMaterial.corrections.length === 0)) {
          // Versuche den Aktualisierungen-Tab zu klicken
          await page.evaluate((id) => {
            const element = document.getElementById(id);
            if (element) {
              const aktualisierungenTab = element.querySelector('a.aktualisierungen');
              if (aktualisierungenTab) {
                aktualisierungenTab.click();
              }
            }
          }, heftId);

          // Warte, bis die Aktualisierungen geladen sind
          await new Promise(resolve => setTimeout(resolve, 2000));

          // Versuche nochmal die Korrekturhinweise zu finden
          const correctionUpdate = await page.evaluate((id) => {
            const element = document.getElementById(id);
            if (!element) return [];
            
            let corrections = [];
            const allLinks = element.querySelectorAll('a');
            allLinks.forEach(link => {
              const href = link.getAttribute('href');
              const text = (link.innerText || link.textContent).trim();
              // Suche nach Links zu /download/index/aktualisierung/
              if (href && href.includes('/download/index/aktualisierung/')) {
                corrections.push({
                  url: href,
                  filename: text
                });
              }
            });
            return corrections;
          }, heftId);

          if (correctionUpdate.length > 0) {
            heftMaterial.corrections = correctionUpdate;
          }
        }

        if (heftMaterial) {
          materials.push(heftMaterial);
          console.log(`    ✓ ${heftMaterial.title}`);
        }
      } catch (error) {
        console.error(`    ❌ Fehler bei Lernheft ${heftId}:`, error.message);
      }
    }

    console.log(`✅ ${materials.length} Lernmaterialien gefunden!`);
    return materials;
    
  } catch (error) {
    console.error('❌ Fehler beim Abrufen der Lernmaterialien:', error.message);
    throw error;
  }
}
