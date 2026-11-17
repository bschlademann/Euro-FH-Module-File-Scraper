import puppeteer from 'puppeteer';

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

          if (titleMatch) {
            moduleList.push({
              title: titleMatch,
              code: moduleCode,
              id: moduleId,
              url: `https://www.euro-fh-campus.de/studiumneu/?module=${moduleId}`
            });
          }
        } catch (e) {
          console.error('Fehler beim Parsen von Modul:', e.message);
        }
      });

      return moduleList;
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
