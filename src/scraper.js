import puppeteer from 'puppeteer';

// Maximale Wartezeit (ms), bis ein PDF-Link nach dem Klick auf ein Heft erscheint
const PDF_WAIT_TIMEOUT = 2500;
// Maximale Wartezeit (ms), bis Korrekturhinweise nach dem Klick auf den Aktualisierungen-Tab erscheinen
const CORRECTION_POLL_TIMEOUT = 1200;
// Kurze Wartezeit (ms) für Hefttypen, die fast nie ein PDF haben (Flashcards, Klausur)
const PDF_SKIP_TYPE_WAIT = 800;
// Experiment: Modul-Öffnen (Editor-AJAX) überspringen und prüfen, ob die
// PDF-Links auch ohne das Öffnen im initialen DOM stehen. Aktivieren mit
// SKIP_MODULE_OPEN=true in der .env oder Umgebung. Lazy ausgewertet, damit
// die .env (dotenv) vorher geladen ist.
function skipModuleOpen() {
  return process.env.SKIP_MODULE_OPEN === 'true';
}

/**
 * Holt alle verfügbaren Module
 * @param {puppeteer.Page} page - Authentifizierte Seite
 * @returns {Promise<Array>} Array mit Modulen
 */
export async function getModules(page) {
  console.log('Lade alle Module...');
  
  try {
    // Navigiere zur Modulübersicht
    await page.goto('https://www.euro-fh-campus.de/studiumneu/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    console.log('Suche nach Modulen auf der Seite...');
    
    // Warte auf Module zu laden
    try {
      await page.waitForSelector('div.modulebox', { timeout: 15000 });
    } catch (e) {
      console.warn('Module nicht gefunden, versuche verzögerte Suche...');
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
          
          // download only single module
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
      console.warn('Keine Module gefunden!');
      console.log('Seite HTML wird angezeigt für Debugging...');
    }

    console.log(`${modules.length} Module gefunden!`);
    return modules;
    
  } catch (error) {
    console.error('Fehler beim Abrufen der Module:', error.message);
    throw error;
  }
}

/**
 * Holt alle Lernhefte eines Moduls
 * @param {puppeteer.Page} page - Authentifizierte Seite
 * @param {string} moduleId - ID des Moduls (mdl_*)
 * @param {Set<string>} [skipIds] - IDs bereits vorhandener Hefte, die übersprungen werden
 * @returns {Promise<{materials: Array, expected: {studienhefte: number, titles: Array}}>}
 */
export async function getLearningMaterials(page, moduleId, skipIds = null) {
  console.log(`Lade Lernmaterialien für Modul ${moduleId}...`);
  
  try {
    // Stelle sicher dass wir auf der richtigen Seite sind
    const currentUrl = page.url();
    if (!currentUrl.includes('studiumneu')) {
      await page.goto('https://www.euro-fh-campus.de/studiumneu/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
    }

    // Schritt 1: Finde alle Lernhefte (reiner DOM-Read, ohne Modul zu öffnen)
    console.log(`  Suche Lernhefte...`);

    const materials = [];

    const collected = await collectHeftIds(page, moduleId);
    const hefteIds = collected.ids;

    console.log(`  Gefundene Lernhefte: ${hefteIds.length} (davon ${collected.studienhefte} Studienhefte)`);

    // Bereits vorhandene Hefte (Festplatten-Check in index.js) überspringen
    let processIds = hefteIds;
    if (skipIds && skipIds.size > 0) {
      processIds = hefteIds.filter(id => !skipIds.has(id));
      console.log(`  ${hefteIds.length - processIds.length} bereits vorhandene Lernhefte werden übersprungen`);
    }

    // Nichts zu tun?
    if (processIds.length === 0) {
      console.log(`  Modul vollständig, überspringe`);
      return {
        materials: [],
        expected: {
          studienhefte: collected.studienhefte,
          titles: collected.titles
        }
      };
    }

    // Schritt 2: Modul öffnen, damit die Editor-Inhalte (PDF-Links) per AJAX
    // nachgeladen werden. (Experiment SKIP_MODULE_OPEN: testen, ob die
    // Editoren auch ohne Öffnen im initialen DOM stehen.)
    if (skipModuleOpen()) {
      console.log(`  SKIP_MODULE_OPEN aktiv: Modul wird nicht geöffnet`);
    } else {
      await page.evaluate((modId) => {
        const moduleBox = document.querySelector(`div.modulebox[id="mdl_${modId}"]`);
        if (!moduleBox) return false;

        const listTrigger = moduleBox.querySelector('.listtrigger');
        if (listTrigger && !moduleBox.classList.contains('open')) {
          listTrigger.click();
        }
        return true;
      }, moduleId);
    }

    // Schritt 3: Für jedes fehlende Lernheft PDFs holen.
    // Erst direkt aus dem DOM lesen (0 Wartezeit); nur wenn kein PDF-Link
    // vorhanden ist, wird gewartet und ggf. geklickt.
    for (const heftId of processIds) {
      try {
        console.log(`    Verarbeite ${heftId}...`);

        // Hefttypen ohne PDF (Flashcards, Klausur) bekommen nur eine kurze Wartezeit.
        const heftType = (collected.types && collected.types[heftId]) || '';
        const isPdfLessType = heftType.includes('flashcards') || heftType.includes('klausur');
        const waitTimeout = isPdfLessType ? PDF_SKIP_TYPE_WAIT : PDF_WAIT_TIMEOUT;

        let heftMaterial = null;
        let nullReason = '';

        const extract = async () => {
          const result = await extractHeftMaterial(page, heftId, collected.titleById[heftId]);
          if (result && result._nullReason) {
            nullReason = result._nullReason;
            return false;
          }
          heftMaterial = result;
          return true;
        };

        // 1) Reines DOM-Lesen, ohne Wartezeit
        if (!(await extract())) {
          // PDF-lose Typen brauchen keinen Klick und kein Warten
          if (nullReason === 'no-pdf' && !isPdfLessType) {
            // 2) Warten (Editor-AJAX vom Modul-Öffnen ist evtl. noch nicht fertig)
            await waitForPdfLink(page, heftId, waitTimeout);
            if (!(await extract())) {
              // 3) Klick-Fallback: Heft auf-/zuklappen (2 Versuche als Toggle)
              for (let attempt = 0; attempt < 2 && !heftMaterial; attempt++) {
                await clickHeft(page, heftId);
                await waitForPdfLink(page, heftId, waitTimeout);
                await extract();
              }
            }
          }
        }

        if (!heftMaterial) {
          console.log(`    ${heftId}: kein PDF gefunden (${nullReason || 'unbekannt'})`);
        }

        // Wenn keine Korrekturhinweise gefunden wurden, klicke auf den Aktualisierungen-Tab
        if (heftMaterial && (!heftMaterial.corrections || heftMaterial.corrections.length === 0)) {
          // Versuche den Aktualisierungen-Tab zu klicken (nur wenn er existiert)
          const tabClicked = await page.evaluate((id) => {
            const element = document.getElementById(id);
            if (element) {
              const aktualisierungenTab = element.querySelector('a.aktualisierungen');
              if (aktualisierungenTab) {
                aktualisierungenTab.click();
                return true;
              }
            }
            return false;
          }, heftId);

          // Nur warten, wenn der Tab wirklich geklickt wurde
          if (tabClicked) {
            const correctionUpdate = await waitForCorrections(page, heftId);
            if (correctionUpdate.length > 0) {
              heftMaterial.corrections = correctionUpdate;
            }
          }
        }

        if (heftMaterial) {
          materials.push(heftMaterial);
          console.log(`    ${heftMaterial.title}`);
        }
      } catch (error) {
        console.error(`    Fehler bei Lernheft ${heftId}:`, error.message);
      }
    }

    console.log(`${materials.length} Lernmaterialien gefunden!`);

    return {
      materials,
      expected: {
        studienhefte: collected.studienhefte,
        titles: collected.titles
      }
    };
    
  } catch (error) {
    console.error('Fehler beim Abrufen der Lernmaterialien:', error.message);
    throw error;
  }
}

/**
 * Sammelt alle Lernheft-IDs eines Moduls und die erwarteten Studienhefte.
 *
 * Die Lerneinheiten stehen bereits im initialen DOM (.modulelist) – es muss
 * also nichts aufgeklappt werden. Kurzer Retry, falls die Liste noch nicht
 * gerendert ist.
 *
 * @param {puppeteer.Page} page - Authentifizierte Seite
 * @param {string} moduleId - ID des Moduls (mdl_*)
 * @returns {Promise<{ids: string[], studienhefte: number, titles: string[], types: Object<string, string>, titleById: Object<string, string>}>}
 */
export async function collectHeftIds(page, moduleId) {
  const moduleSelector = `div.modulebox[id="mdl_${moduleId}"]`;

  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await page.evaluate((sel) => {
      const moduleBox = document.querySelector(sel);
      if (!moduleBox) return { ids: [], studienhefte: 0, titles: [], types: {}, titleById: {} };

      const ids = new Set();
      const studienheftTitles = [];
      const types = {};
      const titleById = {};

      const lists = moduleBox.querySelectorAll('.modulelist');

      lists.forEach((list) => {
        list.querySelectorAll('div.lerneinheit.heft[id^="le_"]').forEach((el) => {
          const id = el.getAttribute('id');
          if (id && id !== 'le_') ids.add(id);

          const titleElement = el.querySelector('.cell.title strong.title-id');
          if (!titleElement) return;

          const typeEm = titleElement.querySelector('em');
          const type = typeEm ? typeEm.textContent.trim().toLowerCase() : '';
          if (type) types[id] = type;

          // Titel identisch zum Download aufbauen: titleId - dfnText
          let titleId = '';
          for (let node of titleElement.childNodes) {
            if (node.nodeType === 3) titleId += node.textContent.trim();
          }
          if (!titleId) {
            titleId = (titleElement.innerText || titleElement.textContent || '').trim();
          }

          const dfnElement = el.querySelector('.cell.title dfn dfn');
          const dfnText = dfnElement ? (dfnElement.innerText || dfnElement.textContent || '').trim() : '';
          const fullTitle = dfnText ? `${titleId} - ${dfnText}` : titleId;
          if (id) titleById[id] = fullTitle;

          // Nur "Studienheft"-Lerneinheiten für den Abgleich zählen
          // (nicht EF/H, Flashcards, Klausuren)
          if (type !== 'studienheft') return;
          studienheftTitles.push(fullTitle);
        });
      });

      // Sonderfall "angerechnete" Module (z.B. MD WIAR BK2, MD ALBE BK1):
      // Keine einzelnen .lerneinheit.heft-Elemente, sondern EINE Lerneinheit
      // (id="le_") mit allen Materialien als h3 + .downloadbox.material Blöcke.
      // Die PDF-URLs liegen in window.cenPlayer[fileId].
      if (ids.size === 0) {
        lists.forEach((list) => {
          list.querySelectorAll('.downloadbox.material').forEach((box) => {
            const pdfLink = box.querySelector('a.pdf[id^="mat_"]');
            if (!pdfLink) return;
            const fileId = pdfLink.getAttribute('id').replace('mat_', '');
            const id = `mat_${fileId}`;
            ids.add(id);
            types[id] = 'credited';

            let h3 = box.previousElementSibling;
            while (h3 && h3.tagName !== 'H3') h3 = h3.previousElementSibling;
            const clink = h3 && h3.querySelector('.clink');
            const dfn = h3 && h3.querySelector('dfn');
            if (!clink) return;

            const titleId = (clink.textContent || '').trim();
            const dfnText = dfn ? (dfn.textContent || '').trim() : '';
            const fullTitle = dfnText ? `${titleId} - ${dfnText}` : titleId;
            titleById[id] = fullTitle;
            studienheftTitles.push(fullTitle);
          });
        });
      }

      return {
        ids: Array.from(ids),
        studienhefte: studienheftTitles.length,
        titles: studienheftTitles,
        types,
        titleById
      };
    }, moduleSelector);

    if (result.ids.length > 0) return result;
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return { ids: [], studienhefte: 0, titles: [], types: {}, titleById: {} };
}

/**
 * Klickt auf das Lernheft, um den Editor (PDF-Links) zu öffnen.
 * @param {puppeteer.Page} page - Authentifizierte Seite
 * @param {string} heftId - ID des Lernhefts (le_*)
 */
async function clickHeft(page, heftId) {
  await page.evaluate((id) => {
    const element = document.getElementById(id);
    if (element) {
      const titleLink = element.querySelector('.cell.title');
      if (titleLink) {
        titleLink.click();
      } else {
        element.click();
      }
    }
  }, heftId);
}

/**
 * Wartet dynamisch, bis im Editor-Container des Hefts ein PDF-Link erscheint.
 * @param {puppeteer.Page} page - Authentifizierte Seite
 * @param {string} heftId - ID des Lernhefts (le_*)
 * @param {number} timeout - Maximale Wartezeit in ms
 * @returns {Promise<boolean>} true, wenn ein PDF-Link gefunden wurde
 */
async function waitForPdfLink(page, heftId, timeout) {
  const leid = heftId.replace('le_', '');
  const editorSelector = `#assignment_content_${leid}`;
  try {
    await page.waitForFunction(
      (sel) => {
        const editor = document.querySelector(sel);
        return editor && editor.querySelector('a.pdf[href*="/studium/index/pdf"]');
      },
      { timeout },
      editorSelector
    );
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Extrahiert Titel, PDF-URL und Korrekturhinweise eines Lernhefts.
 * Liefert bei Fehlern ein Objekt mit _nullReason (nie ein leeres null),
 * damit die Ursache geloggt und ggf. ein Retry gemacht werden kann.
 * @param {puppeteer.Page} page - Authentifizierte Seite
 * @param {string} heftId - ID des Lernhefts (le_* oder mat_*)
 * @param {string} [fallbackTitle] - Titel aus dem Pre-Scan (titleById), für mat_* bevorzugt
 * @returns {Promise<Object>} Material oder { _nullReason }
 */
async function extractHeftMaterial(page, heftId, fallbackTitle = '') {
  return page.evaluate(({ id, fallbackTitle }) => {
    // Sonderfall "angerechnete" Module (z.B. MD WIAR BK2, MD ALBE BK1):
    // Keine .lerneinheit.heft, sondern a.pdf#mat_* mit der URL in window.cenPlayer[fileId].
    if (id.startsWith('mat_')) {
      const fileId = id.replace('mat_', '');
      const pdfLink = document.getElementById(id);
      if (!pdfLink) return { _nullReason: 'no-element' };

      const url = window.cenPlayer ? window.cenPlayer[fileId] : undefined;
      if (!url) return { _nullReason: 'no-pdf', _debug: `cenPlayer[${fileId}] fehlt` };

      // Titel: wie im Pre-Scan aus dem h3 vor dem downloadbox-Block bauen,
      // sonst den übergebenen Titel aus titleById verwenden.
      let title = fallbackTitle;
      if (!title) {
        const box = pdfLink.closest('.downloadbox.material');
        let h3 = box ? box.previousElementSibling : null;
        while (h3 && h3.tagName !== 'H3') h3 = h3.previousElementSibling;
        const clink = h3 && h3.querySelector('.clink');
        const dfn = h3 && h3.querySelector('dfn');
        const titleId = clink ? (clink.textContent || '').trim() : '';
        const dfnText = dfn ? (dfn.textContent || '').trim() : '';
        title = dfnText ? `${titleId} - ${dfnText}` : (titleId || `Mat${fileId}`);
      }

      // Korrekturhinweise innerhalb des downloadbox-Blocks (meist keine vorhanden)
      const corrections = [];
      const box = pdfLink.closest('.downloadbox.material');
      if (box) {
        box.querySelectorAll('a').forEach(link => {
          const href = link.getAttribute('href');
          const text = (link.innerText || link.textContent).trim();
          if (href && href.includes('/download/index/aktualisierung/')) {
            corrections.push({ url: href, filename: text });
          }
        });
      }

      return { title, pdfUrl: url, corrections, _debug: `cenPlayer[${fileId}]` };
    }

    const element = document.getElementById(id);
    if (!element) return { _nullReason: 'no-element' };

    // Hole Titel: GDI01 - Einführung in die Informatik
    const titleElement = element.querySelector('.cell.title strong.title-id');
    const dfnElement = element.querySelector('.cell.title dfn dfn');

    if (!titleElement) return { _nullReason: 'no-title' };

    // Extrahiere GDI01 aus strong.title-id (nur Text-Nodes, ohne <em>Studienheft</em>)
    let titleId = '';
    for (let node of titleElement.childNodes) {
      if (node.nodeType === 3) titleId += node.textContent.trim();
    }
    // Falls childNodes nicht funktioniert, fallback
    if (!titleId) {
      titleId = (titleElement.innerText || titleElement.textContent || '').trim();
      titleId = titleId.replace(/\s+studienheft\s*/gi, '').trim();
    }

    // Extrahiere "Einführung in die Informatik" aus der dfn
    let fullTitle = titleId;
    if (dfnElement) {
      const dfnText = (dfnElement.innerText || dfnElement.textContent || '').trim();
      if (dfnText && dfnText.length > 0) {
        fullTitle = `${titleId} - ${dfnText}`;
      }
    }

    let pdfUrl = null;
    let foundVia = '';

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
    element.querySelectorAll('a').forEach(link => {
      const href = link.getAttribute('href');
      const text = (link.innerText || link.textContent).trim();
      if (href && href.includes('/download/index/aktualisierung/')) {
        corrections.push({ url: href, filename: text });
      }
    });

    if (!pdfUrl) {
      return { _nullReason: 'no-pdf', _debug: `Editor: ${editor ? 'vorhanden' : 'fehlt'}, kein a.pdf-Link gefunden` };
    }

    // Stelle sicher dass die URL absolut ist
    let fullUrl = pdfUrl;
    if (!fullUrl.startsWith('http')) {
      fullUrl = 'https://www.euro-fh-campus.de' + (fullUrl.startsWith('/') ? '' : '/') + fullUrl;
    }

    return {
      title: fullTitle,
      pdfUrl: fullUrl,
      corrections: corrections.length > 0 ? corrections : [],
      _debug: `Found via: ${foundVia}`
    };
  }, { id: heftId, fallbackTitle });
}

/**
 * Pollt die Korrekturhinweise eines Hefts nach dem Klick auf den
 * Aktualisierungen-Tab. Bricht ab, sobald Korrekturhinweise erscheinen,
 * sonst nach spätestens CORRECTION_POLL_TIMEOUT ms.
 * @param {puppeteer.Page} page - Authentifizierte Seite
 * @param {string} heftId - ID des Lernhefts (le_*)
 * @returns {Promise<Array>} Array mit Korrekturhinweisen
 */
async function waitForCorrections(page, heftId) {
  const start = Date.now();

  while (Date.now() - start < CORRECTION_POLL_TIMEOUT) {
    const corrections = await page.evaluate((id) => {
      const element = document.getElementById(id);
      if (!element) return [];

      const found = [];
      element.querySelectorAll('a').forEach(link => {
        const href = link.getAttribute('href');
        const text = (link.innerText || link.textContent).trim();
        // Suche nach Links zu /download/index/aktualisierung/
        if (href && href.includes('/download/index/aktualisierung/')) {
          found.push({
            url: href,
            filename: text
          });
        }
      });
      return found;
    }, heftId);

    if (corrections.length > 0) return corrections;
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  return [];
}
