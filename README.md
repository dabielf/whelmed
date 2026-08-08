# Whelmed.

Just what you need to keep your values in mind. No more. No less.

## Run locally

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm db:migrate:local
pnpm dev
```

Open `http://localhost:5173`.

## Check the app

```sh
pnpm check
```

The deployed Worker expects two secrets: `TEAM_DOMAIN` and `POLICY_AUD`.
The D1 `database_id` in `wrangler.jsonc` is local-only until a remote database is created.
