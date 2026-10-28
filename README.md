# SGS Tracker

Internal tool for Solid Gold Systems website leads: **tracker.solidgoldsystems.com**

Internal only (login required). Two modules:

- **Clients**: every client's profile, contacts, partner (e.g. 633 Studios), services with their own prices (price history kept), ad accounts, who pays Meta, and an ad launch/pause timeline. Monthly recurring totals per client, per partner and overall. Services catalog and partners are edited in Settings.
- **Website Leads**: 4-stage board, lead details, files, build checklist, notes, **Export build kit (.zip)**, and **Convert to client**.
- **Website form link** (on a client): a private link to the detailed form that skips the short form and booking. One use, expires in 14 days, stored in `intake_invites`; the lead it creates is linked to the client.

Full roadmap: Meta billing imports, month-end documents, Stripe sync, pay-per-lead charging (see the project plan).

Leads come from the detailed intake form on **websites.solidgoldsystems.com** (shown after someone books a call, plus a standalone copy at `/intake/`). The form only opens with proof checked on the server: a pass signed right after the short form, a client invite link, or a `cid` of a GHL contact tagged `lp-website-500`. That site's Netlify functions write the lead and files into Supabase; this app only reads and manages them.

## How it fits together

| Piece | Where |
|---|---|
| Code | This repo; every push to `main` auto-deploys on Netlify (`solidgoldtracker`) — push only when a change is ready, each deploy uses Netlify credits |
| Intake form + functions | websites.solidgoldsystems.com (separate Netlify site, drag-and-drop zip) |
| Data + files | Supabase project `sgs-tracker`: `leads`, `lead_files`, `team_members`, `clients`, `client_contacts`, `partners`, `services`, `client_services` (+ price history), `ad_events`, `intake_invites`; private bucket `intake` |
| CRM | Intake submissions (from the websites site) update the GHL contact and add the tag `website-intake-complete` |

## Files

```
public/index.html            Tracker app
public/assets/schema.js      THE list of questions, file types, checklist and stages
public/assets/tracker.js     Tracker shell: sign-in, 2FA, routing, Website Leads, Admin, Settings
public/assets/clients.js     Clients module: clients, contacts, partners, services and prices, ad timeline
public/assets/config.js      Public Supabase URL + anon key
```

`schema.js` is also used by the intake form on the websites site (`assets/intake/schema.js`). Keep the two copies identical: change a question in one, copy it to the other.

## Netlify environment variables

None needed for this site (it has no server functions). The websites site holds `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GHL_TOKEN`, `GHL_LOCATION_ID`.

## Sign-in and 2FA

Password, then a 6-digit code emailed to them (Resend). A sign-in stays verified for 30 days or until they sign out.
**Inactivity timeout:** no activity for 1 hour signs them out (browser timer across tabs, plus the database refuses sessions that haven't checked in for 60 minutes).
The database only returns Tracker data to sessions that passed the code (`public.session_verified()`).

Supabase Edge Functions (no Netlify credits; source in `supabase/functions/`):
- `email-2fa`: sends and checks the codes. Needs the Supabase secret `RESEND_API_KEY`.
- `admin-users`: Admin page actions (list, invite, copy invite link, change role, sign out, remove). Admins only.

## Giving someone access

Tracker → **Admin** → Invite someone. They get an email (sent by Supabase Auth through Resend SMTP), choose a password, then confirm an emailed code. If the email can't be sent, the Admin page gives you a one-time link to send yourself.

## Intake link for GHL texts/emails

Works only for contacts tagged `lp-website-500` (everyone who came through the website form). For existing clients use **Website form link** instead.

```
https://websites.solidgoldsystems.com/intake/?name={{contact.name}}&email={{contact.email}}&phone={{contact.phone}}&business={{contact.company_name}}&cid={{contact.id}}
```
