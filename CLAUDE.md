# saunainstall.com — static site

## What this folder is
A static marketing + flow prototype for saunainstall.com, a marketplace connecting sauna owners with installation contractors. Deployed to Vercel as plain static files (no build step).

## Files
- `index.html` — homepage (served at `/`)
- `list-project.html` — sauna owner flow (served at `/list-project`): account sign-up → list project → thank-you → owner login (`#login`) → owner dashboard with proposals
- `contractors.html` — contractor flow (served at `/contractors`): pricing ($24.99/mo, first month free, unlimited bids) → sign-up → find projects by zip/city → payment (Stripe Checkout) → bid on project → contractor login (`#login`) → dashboard
- `privacy.html`, `terms.html` — Privacy Policy and Terms of Service for Sauna Install LLC (served at `/privacy` and `/terms`). Plain static pages (not design-tool bundles); keep in sync with the Google Docs drafts in the saunainstall-site Drive folder.
- `support.html` — customer support page (served at `/support`); its URL is the customer support URL given to Stripe.
- `images/` — site photos. Must be deployed; the homepage "What we install" cards load from `/images/`.
- `vercel.json` — enables clean URLs (`/contractors` instead of `/contractors.html`)
- `design-source/` — the editable design files these pages were compiled from. Reference only; do NOT deploy this folder.

The three root `.html` files are self-contained bundles (fonts, scripts, markup inlined). Do not hand-edit them for large changes; new versions come from the design tool as full-file replacements. Small text fixes directly in these files are fine.

## Publishing (Vercel, no GitHub)
1. Ensure the Vercel CLI is installed: `npm install -g vercel` (requires Node.js).
2. From this folder, run `vercel login` once if not authenticated.
3. Deploy: `vercel --prod`
   - First run: link to the existing project for saunainstall.com (or create it). Framework: Other. No build command. Output directory: `.` (root).
   - Exclude `design-source/` from deploys — see `.vercelignore`.
4. Domain: in the Vercel dashboard → Project → Settings → Domains, add `saunainstall.com` and `www.saunainstall.com`, then add the DNS records Vercel shows at the domain registrar.

## Publishing (GitHub + Vercel, optional)
If the user prefers Git-based deploys: initialize git here, push to the GitHub repo `saunainstall.com`, and import that repo in Vercel. Every push then redeploys automatically.

## Updating the site
The user will download a new version of the three `.html` files from the design tool. To update:
1. Replace `index.html`, `list-project.html`, `contractors.html` (and `design-source/` if provided) with the new files.
2. Run `vercel --prod` (or commit + push if using GitHub).

## Backend (Supabase + Stripe)
- `js/si.js` — dependency-free connector loaded by `contractors.html` and `list-project.html` (exposes `window.SI`): accounts, projects, bids, reviews (Supabase project "Saunainstall Project", ref `knpxvuicsjlhruqpdmzy`) and membership checkout / billing portal (Supabase edge functions `create-checkout`, `billing-portal`, `stripe-webhook`).
- Database access is enforced by row-level security in Supabase; Stripe keys live in Supabase Vault, never in this repo.
- **After replacing `contractors.html` or `list-project.html` with a new design-tool export, re-apply the wiring** (otherwise forms go back to demo-only):
  ```
  python3 tools/unpack.py contractors.html /tmp/c.tpl.html && python3 tools/wire-backend.py contractors /tmp/c.tpl.html /tmp/c.new.html && python3 tools/repack.py contractors.html /tmp/c.new.html
  python3 tools/unpack.py list-project.html /tmp/h.tpl.html && python3 tools/wire-backend.py homeowner /tmp/h.tpl.html /tmp/h.new.html && python3 tools/repack.py list-project.html /tmp/h.new.html
  ```
  `wire-backend.py` reports any edit that no longer matches the new design; fix those before publishing.

## Current limitations
- Contractor payouts and homeowner payments are not handled on the site; homeowners pay installers directly (no Stripe Connect yet).
- No transactional email yet (new-proposal and hired notifications); sign-up email confirmation is turned off in Supabase until an email service is connected.
- No password-reset or log-out links in the page designs yet.
