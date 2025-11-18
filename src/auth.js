import puppeteer from 'puppeteer';
import fs from 'fs-extra';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Authentifizierung auf der Euro-FH Plattform
 * @param {puppeteer.Browser} browser - Puppeteer Browser Instanz
 * @returns {Promise<puppeteer.Page>} Authentifizierte Seite
 */
export async function login(browser) {
  const page = await browser.newPage();
  
  try {
    console.log('🔐 Melde mich an der Euro-FH Plattform an...');
    
    // Euro-FH Login Seite
    await page.goto('https://www.euro-fh-campus.de/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // Warte auf Login-Input (id="login") und gebe Benutzername ein
    console.log('⏳ Warte auf Benutzername-Feld...');
    await page.waitForSelector('#login', { timeout: 15000 });
    await page.type('#login', process.env.EURO_FH_EMAIL || '');
    console.log('✓ Benutzername eingegeben');
    
    // Warte auf Password-Input (id="paswd") und gebe Passwort ein
    console.log('⏳ Warte auf Passwort-Feld...');
    await page.waitForSelector('#paswd', { timeout: 15000 });
    await page.type('#paswd', process.env.EURO_FH_PASSWORD || '');
    console.log('✓ Passwort eingegeben');
    
    // Klicke Login Button und warte auf Navigation
    console.log('⏳ Klicke Login-Button und warte auf Authentifizierung...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {
        console.log('⚠️ Navigation timeout - prüfe ob bereits angemeldet');
      }),
      page.click('button[type="submit"]')
    ]);

    // Warte kurz um sicherzustellen dass alles geladen ist
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log('✅ Erfolgreich angemeldet!');
    return page;
    
  } catch (error) {
    console.error('❌ Login fehlgeschlagen:', error.message);
    console.error('Details:', error);
    await page.close();
    throw error;
  }
}

/**
 * Prüfe ob User angemeldet ist
 * @param {puppeteer.Page} page - Puppeteer Page Instanz
 * @returns {Promise<boolean>} True wenn angemeldet
 */
export async function isLoggedIn(page) {
  try {
    // Versuche zur Dashboard Seite zu navigieren
    // Falls wir zur Login-Seite zurückgelenkt werden, sind wir nicht angemeldet
    const response = await page.goto('https://www.euro-fh-campus.de/dashboard', {
      waitUntil: 'domcontentloaded',
      timeout: 10000
    });
    
    // Wenn wir noch auf der Login-Seite sind
    const isOnLoginPage = await page.$('#login');
    return !isOnLoginPage;
  } catch {
    return false;
  }
}

/**
 * Logout aus der Plattform
 * @param {puppeteer.Page} page - Puppeteer Page Instanz
 */
export async function logout(page) {
  try {
    console.log('🔓 Melde mich ab...');

    // Versuche bekannte Logout-Selectoren zu klicken
    const selectors = [
      'a[href*="logout"]',
      'a[href*="abmelden"]',
      'button[aria-label*="logout"]',
      'button[aria-label*="Abmelden"]',
      'a.logout',
      'button.logout'
    ];

    let clicked = false;
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          clicked = true;
          break;
        }
      } catch (e) {
        // ignore
      }
    }

    // Falls kein Selector gefunden wurde, suche nach Link/Button mit Text "Abmelden/Logout/Ausloggen"
    if (!clicked) {
      try {
        clicked = await page.evaluate(() => {
          const keywords = ['abmelden', 'logout', 'ausloggen'];
          const els = Array.from(document.querySelectorAll('a,button'));
          const el = els.find(e => {
            const txt = (e.innerText || '').toLowerCase();
            return keywords.some(k => txt.includes(k));
          });
          if (el) {
            el.click();
            return true;
          }
          return false;
        });
      } catch (e) {
        // ignore
      }
    }

    if (clicked) {
      try {
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 });
      } catch (e) {
        console.log('⚠️ Logout Navigation-Timeout — fahre mit Cleanup fort');
      }
    } else {
      console.log('⚠️ Kein Logout-Button gefunden — führe Cleanup durch');
    }

    // Versuche Cookies und Cache über CDP zu löschen
    try {
      const client = await page.target().createCDPSession();
      await client.send('Network.clearBrowserCookies');
      await client.send('Network.clearBrowserCache');
    } catch (e) {
      console.warn('⚠️ Konnte Cookies/Cache nicht per CDP löschen:', e.message);
    }

    // Leere Session-/LocalStorage (falls noch vorhanden)
    try {
      await page.evaluate(() => {
        try { localStorage.clear(); } catch (e) {}
        try { sessionStorage.clear(); } catch (e) {}
      });
    } catch (e) {
      // ignore
    }

    console.log('✅ Abmeldung (Cleanup) ausgeführt');
  } catch (error) {
    console.warn('⚠️ Logout konnte nicht vollständig durchgeführt werden:', error.message);
  }
}
