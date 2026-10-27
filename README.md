# SGS Tracker

Internal tool for Solid Gold Systems website leads: **tracker.solidgoldsystems.com**

Internal only (login required): 4-stage board, lead details, files, build checklist, notes, and **Export build kit (.zip)**.

Leads come from the detailed intake form on **websites.solidgoldsystems.com** (shown after someone books a call, plus a standalone copy at `/intake/`). That site's Netlify functions write the lead and files into Supabase; this app only reads and manages them.

## How it fits together

| Piece | Where |
|---|---|
| Code | This repo; every push to `main` auto-deploys on Netlify (`solidgoldtracker`) — push only when a change is ready, each deploy uses Netlify credits |
| Intake form + functions | websites.solidgoldsystems.com (separate Netlify site, drag-and-drop zip) |
| Data + files | Supabase project `sgs-tracker` (tables `leads`, `lead_files`, `team_members`; private bucket `intake`) |
| CRM | Intake submissions (from the websites site) update the GHL contact and add the tag `website-intake-complete` |

## Files

```
public/index.html            Tracker app
public/assets/schema.js      THE list of questions, file types, checklist and stages
public/assets/tracker.js     Tracker logic
public/assets/config.js      Public Supabase URL + anon key
```

`schema.js` is also used by the intake form on the websites site (`assets/intake/schema.js`). Keep the two copies identical: change a question in one, copy it to the other.

## Netlify environment variables

None needed for this site (it has no server functions). The websites site holds `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GHL_TOKEN`, `GHL_LOCATION_ID`.

## Giving someone access

1. Supabase → Authentication → Users → Add user (email + password, auto-confirm).
2. Add their email to the `team_members` table.

## Intake link for GHL texts/emails

```
https://websites.solidgoldsystems.com/intake/?name={{contact.name}}&email={{contact.email}}&phone={{contact.phone}}&business={{contact.company_name}}&cid={{contact.id}}
```
