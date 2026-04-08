# Euro-FH Scraper

Automatic download tool for Euro-FH learning materials. Downloads all your modules with study guides and correction notes.

## Features

- Automatic authentication on the Euro-FH platform
- Automatically retrieve all modules
- Download study guides per module
- Save correction notes
- Automatic folder structure (Module → Study Guide → PDFs)
- Clear summary of downloads

## Requirements

- Node.js 16+ installed ([Download](https://nodejs.org))
- Active Euro-FH account

## Installation

1. **Clone repository:**
   ```bash
   cd "Euro-FH scraper"
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Create .env file:**
   ```bash
   cp .env.example .env
   ```

4. **Enter credentials in .env:**
   ```env
   EURO_FH_EMAIL=your-email@example.com
   EURO_FH_PASSWORD=your-password
   ```

## Folder Structure

Downloads are organized in the following structure:

```
downloads/
├── Module 1/
│   ├── Study Guide 1/
│   │   ├── Study Guide 1.pdf
│   │   └── Study Guide 1_Correction Notes.pdf
│   └── Study Guide 2/
│       └── Study Guide 2.pdf
└── Module 2/
    └── Study Guide 3/
        └── Study Guide 3.pdf
```

## Usage

### Normal startup:
```bash
npm start
```

### Development mode (with auto-reload):
```bash
npm run dev
```

The program will guide you through the download process:
1. Connect to the Euro-FH platform
2. Retrieve all available modules
3. Confirm before download
4. Automatically download all materials
5. Summary of downloads

## Configuration

Edit the `.env` file for the following options:

| Variable | Description | Default |
|----------|-------------|----------|
| `EURO_FH_EMAIL` | Your Euro-FH email | - |
| `EURO_FH_PASSWORD` | Your Euro-FH password | - |
| `HEADLESS` | Start browser in headless mode | `true` |
| `DOWNLOAD_DIR` | Directory for downloads | `./downloads` |
| `DOWNLOAD_TIMEOUT` | Timeout for downloads (ms) | `30000` |

## 📝 License

ISC License - This project is for personal use only