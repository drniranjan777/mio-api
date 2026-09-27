# MIO Doctors — API

Node.js 24 · Express 4 · MongoDB (Mongoose 8) · JWT (access + rotating refresh tokens) · Zod validation.

Serves the Flutter app ([mioapp](https://github.com/drniranjan777/mioapp)) and the admin panel ([mio-admin](https://github.com/drniranjan777/mio-admin)).

## Run locally

```bash
cp .env.example .env          # fill JWT_ACCESS_SECRET and OTP_PEPPER (long random strings)
npm install
npm run db                    # local MongoDB on 127.0.0.1:27017 (data in .data/), or use your own
npm run seed:demo             # catalogue + demo doctors/MR/receptionists/appointments
npm run dev                   # http://localhost:4000/api/v1
```

First admin: set `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` in `.env`, then `npm run seed` (or `npm run admin:password` to change it later).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API with auto-reload |
| `npm start` | API (production) |
| `npm test` | Test suite (in-memory MongoDB) |
| `npm run lint` | ESLint |
| `npm run seed` / `seed:demo` | Catalogue (+ demo data) |
| `npm run admin:password` | Create/reset the admin in `SEED_ADMIN_EMAIL` |

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — roles, permissions, data model, API, security, decisions
- [DEPLOYMENT.md](DEPLOYMENT.md) — Hostinger Ubuntu VPS: `api.miodoctors.com` + `admin.miodoctors.com`
- [docs/samples/doctors_import_template.csv](docs/samples/doctors_import_template.csv) — doctor CSV import demo sheet

## Before going live

Add a real SMS gateway (OTP) and payment gateway — until then production answers `SMS_NOT_CONFIGURED` / `PAYMENTS_UNAVAILABLE` (see DEPLOYMENT.md). Never commit `.env`.
