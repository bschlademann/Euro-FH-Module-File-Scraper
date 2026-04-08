# Euro-FH Scraper

Automatisches Download-Tool für Euro-FH Lernmaterialien. Lädt alle deine Module mit Lernheften und Korrekturhinweisen herunter.

## Features

- Automatische Authentifizierung auf der Euro-FH Plattform
- Alle Module automatisch abrufen
- Lernhefte pro Modul herunterladen
- Korrekturhinweise speichern
- Automatische Ordnerstruktur (Modul → Lernheft → PDFs)
- Übersichtliche Zusammenfassung der Downloads

## Voraussetzungen

- Node.js 16+ installiert ([Download](https://nodejs.org))
- Aktiver Euro-FH Account

## Installation

1. **Repository klonen:**
   ```bash
   cd "Euro-FH scraper"
   ```

2. **Dependencies installieren:**
   ```bash
   npm install
   ```

3. **.env Datei erstellen:**
   ```bash
   cp .env.example .env
   ```

4. **Credentials in .env eintragen:**
   ```env
   EURO_FH_EMAIL=deine-email@example.com
   EURO_FH_PASSWORD=dein-passwort
   ```

## Ordnerstruktur

Die Downloads werden in folgende Struktur organisiert:

```
downloads/
├── Modul 1/
│   ├── Lernheft 1/
│   │   ├── Lernheft 1.pdf
│   │   └── Lernheft 1_Korrekturhinweise.pdf
│   └── Lernheft 2/
│       └── Lernheft 2.pdf
└── Modul 2/
    └── Lernheft 3/
        └── Lernheft 3.pdf
```

## Verwendung

### Normaler Start:
```bash
npm start
```

### Entwicklungsmodus (mit Auto-Reload):
```bash
npm run dev
```

Das Programm wird dich durch den Download-Prozess führen:
1. Verbindung zur Euro-FH Plattform
2. Abrufen aller verfügbaren Module
3. Bestätigung vor Download
4. Automatisches Herunterladen aller Materialien
5. Zusammenfassung der Downloads

## Konfiguration

Bearbeite die `.env` Datei für folgende Optionen:

| Variable | Beschreibung | Standard |
|----------|-------------|----------|
| `EURO_FH_EMAIL` | Deine Euro-FH E-Mail | - |
| `EURO_FH_PASSWORD` | Dein Euro-FH Passwort | - |
| `HEADLESS` | Browser im Headless-Modus starten | `true` |
| `DOWNLOAD_DIR` | Verzeichnis für Downloads | `./downloads` |
| `DOWNLOAD_TIMEOUT` | Timeout für Downloads (ms) | `30000` |

## 📝 Lizenz

ISC License - Dieses Projekt ist nur für persönliche Zwecke