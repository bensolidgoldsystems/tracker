# SGS Tracker

Internal tool for Solid Gold Systems website leads: **tracker.solidgoldsystems.com**

- `/intake/` — public website intake form sent to leads after they book. Photos upload at full quality straight to Supabase Storage.
- `/` — the Tracker (login required): 4-stage board, lead details, files, build checklist, notes, and **Export build kit (.zip)**.

## How it fits together

| Piece | Where |
|---|---|
| Code | This repo; every push to `main` auto-deploys on Netlify (`solidgoldtracker`) |
| Data + files | Supabase project `sgs-tracker` (tables `leads`, `lead_files`, `team_members`; private bucket `intake`) |
| CRM | Intake submissions update the GHL contact and add the tag `website-intake-complete` |

## Files

```
public/index.html            Tracker app
public/intake/index.html     Intake form
public/assets/schema.js      THE list of questions, file types, checklist and stages (edit here)
public/assets/intake.js      Intake form logic
public/assets/tracker.js     Tracker logic
public/assets/config.js      Public Supabase URL + anon key
netlify/functions/intake-start.js     Saves answers, returns signed upload URLs
netlify/functions/intake-complete.js  Records uploaded files, pushes to GHL
netlify/lib/shared.js        Supabase + GHL helpers
```

## Netlify environment variables

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GHL_TOKEN`, `GHL_LOCATION_ID` (optional `TRACKER_URL`).

## Giving someone access

1. Supabase → Authentication → Users → Add user (email + password, auto-confirm).
2. Add their email to the `team_members` table.

## Intake link for GHL texts/emails

```
https://tracker.solidgoldsystems.com/intake/?name={{contact.name}}&email={{contact.email}}&phone={{contact.phone}}&business={{contact.company_name}}&cid={{contact.id}}
```
