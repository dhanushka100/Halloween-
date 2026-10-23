# Halloween Contest (Express + SQLite)

## Run on Windows
Needs Node 22.13 or newer (uses the built-in SQLite, so nothing needs compiling).
If you see an old node_modules folder, delete it first:  rmdir /s /q node_modules

Command Prompt (cmd.exe, the prompt looks like C:\...>):
    npm install
    set ADMIN_PASSWORD=choose-a-strong-password
    set IP_SALT=any-random-text
    node server.js

PowerShell (the prompt looks like PS C:\...>):
    npm install
    $env:ADMIN_PASSWORD="choose-a-strong-password"
    $env:IP_SALT="any-random-text"
    node server.js

Open http://localhost:3000 (site) and http://localhost:3000/admin (user: anything, password: your ADMIN_PASSWORD)

## Flow
1. Visitors submit entries (status = pending).
2. In /admin you open each post, then Approve (optionally paste an image URL) or Reject.
3. Approved entries appear in the gallery. Each person gets 1 vote per category (checked by cookie AND hashed IP).
4. After voting ends, /admin shows entries sorted by votes in each category.

## Settings (environment variables)
ENTRY_END  default 2026-11-01T03:59:00Z  (Oct 31, 11:59 PM EDT) – also edit END in public/index.html
VOTE_END   default 2026-11-02T04:59:00Z  (Nov 1, 11:59 PM ET)
DB_FILE    path to the SQLite file (default ./contest.db) – keep it on a persistent disk when hosting
PORT, ADMIN_PASSWORD, IP_SALT

## Hosting notes
Needs a host that can run Node and keep a file on disk (a small VPS, Railway/Render with a persistent disk).
Static-only hosts (Netlify, GitHub Pages) will NOT work for this version.

## Photos
Visitors can upload one photo (resized to max 1200px JPEG in the browser) or paste a link (for videos). Photos are saved in ./uploads (set UPLOAD_DIR to change). Back this folder up and keep it on a persistent disk when hosting.

## Known limits
- Households/offices/universities sharing one IP share one vote per category.
- Add Cloudflare Turnstile (free captcha) on the form and vote button if bots appear.
- Replace [YOUR NAME OR COMPANY] in public/index.html (Rules → Sponsor) and have the rules legally reviewed.
