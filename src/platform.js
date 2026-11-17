import axios from 'axios';
import * as cheerio from 'cheerio';

const BASE_URL = 'https://www.euro-fh-campus.de';
const REQUEST_TIMEOUT = 30000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Macht eine relative URL absolut.
 */
function absoluteUrl(url) {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  return BASE_URL + (url.startsWith('/') ? '' : '/') + url;
}

/**
 * Liest alle Hefte aller Module in einem einzigen DOM-Durchgang aus der
 * Modulübersicht. Es wird nichts angeklickt und nichts erwartet.
 *
 * Zwei Arten von Heften:
 * - le_*: normale Lerneinheiten. PDF-URL und Korrekturen werden danach über
 *   die HTTP-Endpunkte der Plattform geholt.
 * - mat_*: "angerechnete" Module. PDF-URLs stehen bereits im initialen HTML
 *   (window.cenPlayer), Korrekturen direkt im downloadbox-Block.
 */
export async function collectAllHefte(page) {
  return page.evaluate(() => {
    const result = [];

    document.querySelectorAll('div.modulebox[id^="mdl_"]').forEach((box) => {
      const moduleId = box.id.replace('mdl_', '');
      const lists = Array.from(box.querySelectorAll('.modulelist'));
      const hefte = [];
      const credited = [];

      lists.forEach((list) => {
        list.querySelectorAll('div.lerneinheit.heft[id^="le_"]').forEach((el) => {
          const titleElement = el.querySelector('.cell.title strong.title-id');
          if (!titleElement) return;

          let heftname = '';
          for (const node of titleElement.childNodes) {
            if (node.nodeType === 3) heftname += node.textContent.trim();
          }
          if (!heftname) {
            heftname = (titleElement.innerText || titleElement.textContent || '')
              .trim()
              .replace(/\s+studienheft\s*/gi, '')
              .trim();
          }

          const typeElement = titleElement.querySelector('em');
          const type = typeElement ? typeElement.textContent.trim().toLowerCase() : '';
          const dfnElement = el.querySelector('.cell.title dfn dfn');
          const dfnText = dfnElement ? (dfnElement.innerText || dfnElement.textContent || '').trim() : '';
          const title = dfnText ? `${heftname} - ${dfnText}` : heftname;
          const nodeid = el.getAttribute('data-nodeid') || el.id.replace('le_', '');
          const parentid = el.getAttribute('data-parentid') || '';

          hefte.push({ moduleId, heftId: el.id, nodeid, parentid, heftname, title, type, kind: 'le' });
        });

        list.querySelectorAll('.downloadbox.material').forEach((downloadBox) => {
          const link = downloadBox.querySelector('a.pdf[id^="mat_"]');
          if (!link) return;

          const fileId = link.id.replace('mat_', '');
          const pdfUrl = window.cenPlayer ? window.cenPlayer[fileId] : null;

          let h3 = downloadBox.previousElementSibling;
          while (h3 && h3.tagName !== 'H3') h3 = h3.previousElementSibling;
          const clink = h3 && h3.querySelector('.clink');
          const dfn = h3 && h3.querySelector('dfn');
          const titleId = clink ? (clink.textContent || '').trim() : '';
          const dfnText = dfn ? (dfn.textContent || '').trim() : '';
          const title = dfnText ? `${titleId} - ${dfnText}` : titleId;

          const corrections = [];
          downloadBox.querySelectorAll('a').forEach((a) => {
            const href = a.getAttribute('href');
            if (!href || !href.includes('/download/index/aktualisierung/')) return;
            corrections.push({
              url: absoluteUrl(href),
              filename: (a.innerText || a.textContent || '').trim()
            });
          });

          credited.push({
            moduleId,
            heftId: `mat_${fileId}`,
            title,
            type: 'credited',
            kind: 'mat',
            pdfUrl: pdfUrl || null,
            corrections
          });
        });
      });

      // Bei "angerechneten" Modulen gibt es keine le_*-Hefte, sondern nur die
      // inline downloadbox-Blöcke. Nicht beides mischen.
      result.push(...(hefte.length > 0 ? hefte : credited));
    });

    return result;

    function absoluteUrl(url) {
      if (!url) return null;
      if (url.startsWith('http')) return url;
      return 'https://www.euro-fh-campus.de' + (url.startsWith('/') ? '' : '/') + url;
    }
  });
}

/**
 * Holt PDF-URL und Korrekturhinweise eines le_*-Hefts direkt per HTTP.
 */
async function fetchLeHeftData(heft, cookie) {
  const headers = {
    Cookie: cookie,
    'User-Agent': USER_AGENT,
    'X-Requested-With': 'XMLHttpRequest',
    Referer: 'https://www.euro-fh-campus.de/studiumneu/'
  };

  const data = { ...heft, pdfUrl: null, corrections: [] };
  const nodeid = encodeURIComponent(heft.nodeid);
  const fachdk = encodeURIComponent(heft.parentid);

  // Haupt-PDF
  if (heft.nodeid) {
    const url = `${BASE_URL}/studiumneu/index/downloads?option=studienmaterial` +
      `&ajaxurl=%2Fstudiumneu%2Findex%2Fdownloads&demsykey=${nodeid}&dk=${nodeid}&fachdk=${fachdk}`;
    try {
      const response = await axios.get(url, { headers, timeout: REQUEST_TIMEOUT });
      const $ = cheerio.load(response.data);
      const href = $('a.pdf[href*="/studium/index/pdf"]').first().attr('href');
      if (href) data.pdfUrl = absoluteUrl(href);
    } catch (error) {
      data.pdfError = error.message;
    }
  }

  // Korrekturhinweise
  if (heft.nodeid && heft.heftname) {
    const url = `${BASE_URL}/studiumneu/index/aktualisierung?option=aktualisierungen` +
      `&ajaxurl=%2Fstudiumneu%2Findex%2Faktualisierung&fachdk=${fachdk}` +
      `&heftname=${encodeURIComponent(heft.heftname)}&demsykey=${nodeid}&label=`;
    try {
      const response = await axios.get(url, { headers, timeout: REQUEST_TIMEOUT });
      const $ = cheerio.load(response.data);
      $('a[href*="/download/index/aktualisierung/"]').each((_, element) => {
        data.corrections.push({
          url: absoluteUrl($(element).attr('href')),
          filename: $(element).text().trim()
        });
      });
    } catch (error) {
      data.correctionError = error.message;
    }
  }

  return data;
}

/**
 * Sammelt alle Materialien aller Module: ein DOM-Durchgang, dann zwei
 * parallele HTTP-Requests pro Heft statt Klicken und Warten im Browser.
 *
 * @param {puppeteer.Page} page - Angemeldete Seite
 * @param {number} concurrency - Anzahl paralleler Requests
 * @returns {Promise<Array>} Materialien mit moduleId, title, pdfUrl, corrections
 */
export async function getAllMaterials(page, concurrency = 8) {
  const hefte = await collectAllHefte(page);
  const cookies = await page.cookies();
  const cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const results = new Array(hefte.length);
  let next = 0;
  let requests = 0;

  console.log(`  ${hefte.length} Lernhefte im DOM gefunden, hole URLs per HTTP...`);

  async function worker() {
    while (next < hefte.length) {
      const index = next++;
      const heft = hefte[index];
      if (heft.kind === 'mat') {
        results[index] = heft;
      } else {
        requests += 2;
        results[index] = await fetchLeHeftData(heft, cookie);
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, hefte.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const mitPdf = results.filter(m => m.pdfUrl).length;
  const mitKorrektur = results.filter(m => m.corrections && m.corrections.length > 0).length;
  const fehler = results.filter(m => m.pdfError || m.correctionError);
  console.log(`  ${requests} HTTP-Requests, ${mitPdf} PDFs, ${mitKorrektur} Hefte mit Korrekturhinweisen`);
  if (fehler.length > 0) {
    console.warn(`  ${fehler.length} Hefte mit Abruf-Fehlern:`);
    for (const m of fehler.slice(0, 10)) {
      console.warn(`    ${m.heftId}: ${m.pdfError || m.correctionError}`);
    }
  }

  return results;
}
