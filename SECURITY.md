# Security policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private reporting instead: go to the **Security** tab of this
repository → **Report a vulnerability**. That creates a private advisory only
maintainers can see.

Please include: what the issue is, how to reproduce it, and what an attacker
could achieve. A proof of concept helps, but a clear description is enough.

You should get an initial response within a week. There is no bug bounty —
this is a personal open-source project.

## Scope

In scope: anything in this repository — the pipeline worker, the web app, the
SQL migrations and RLS policies, and the documented deployment topology.

Out of scope: vulnerabilities in Supabase, Vercel, Railway, Anthropic, or the
social platform APIs themselves. Report those to the respective vendor.

## Things you should know before deploying

This project handles third-party API credentials and scraped public content.
The design notes worth reading before you run it in anger:

- **Secrets** live in Supabase Vault (via the Connections page) or environment
  variables. Nothing is committed, and `.env` is gitignored. The service-role
  key must never reach the browser.
- **Access is gated in two layers that must agree** — the `ALLOWED_EMAILS`
  environment variable (web session) and the `app_allowlist` table (profile
  creation). Turn off public sign-ups in Supabase once your own account exists;
  see the README's activation section. Leaving public sign-ups on means
  strangers can create monitors that run on *your* API credentials and budget.
- **Row-level security** is enabled on every table, including each monthly
  `raw_items` partition (Postgres does not inherit RLS to partitions — the
  migration and the partition-maintenance function both handle this explicitly).
- **Scraped content is untrusted input.** It is defanged before entering any
  LLM prompt, and any model output rendered as HTML is sanitized. If you add a
  surface that renders or prompts with scraped text, keep both properties.
- **Budgets are a safety feature**, not just a cost control: an unbounded
  classification loop is a denial-of-wallet risk. The global monthly cap pauses
  LLM spend while leaving data collection running.

## Running this responsibly

Monitoring public social content still carries obligations. Respect each
platform's terms of service and rate limits, honour applicable privacy law for
personal data you collect, and prefer official APIs where you have access. The
X adapter defaults to a third-party scraping provider; read that provider's
terms and X's before pointing it at anything.
