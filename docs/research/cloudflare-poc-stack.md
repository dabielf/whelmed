# Smallest current Cloudflare proof-of-concept stack

Checked on 2026-08-08 against current first-party Cloudflare, Hono, and Vite documentation.

## Decision

Use one Cloudflare Worker application containing:

- a client-rendered React single-page app built by Vite;
- static assets served by Workers Static Assets;
- same-origin `/api/*` routes in the same Worker, using Hono;
- one D1 database bound directly to that Worker; and
- the generated `workers.dev` address protected by Cloudflare Access for one exact email address.

This is one deployment, not a Pages site plus a separate API. Cloudflare's current React starter already combines a React SPA, a Worker API, and the Cloudflare Vite plugin. It uses `worker/index.ts` as the API entry point and SPA fallback for client routes. The plugin runs Worker code in the Workers runtime during local development and builds the front-end assets for deployment. [Cloudflare: React + Vite](https://developers.cloudflare.com/workers/framework-guides/web-apps/react/) [Cloudflare: Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)

Hono does not require another service. A Hono app can be the Worker's default export and read Cloudflare bindings from its context. Its official Cloudflare guide also uses Workers Static Assets. For Whelmed's several small create, edit, delete, and history routes, this avoids writing a router by hand while leaving the deployment shape unchanged. [Hono: Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)

## Minimal project shape

```text
src/                 React interface
worker/index.ts      Access check and Hono API routes
migrations/*.sql     Ordered D1 schema changes
index.html
vite.config.ts
wrangler.jsonc       Worker, static assets, variables, and D1 binding
```

Use the current Cloudflare React scaffold when building starts. Do not add server-side rendering, Cloudflare Pages, a second Worker, an object-relational mapper (ORM), or a separate API deployment for this proof of concept.

### Request routing

Set the static asset fallback to `single-page-application`. Cloudflare first serves a matching built asset and invokes the Worker when no asset matches. The React app can call same-origin `/api/*` URLs, so no cross-origin configuration is needed. Cloudflare documents `assets.run_worker_first` for explicit advanced routing, but also says the SPA fallback alone is enough in most cases; leave that option out unless real routing behavior requires it. [Cloudflare: React asset routing](https://developers.cloudflare.com/workers/framework-guides/web-apps/react/#asset-routing) [Cloudflare: SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)

Vite's normal production build writes deployable assets to `dist` by default. The Cloudflare Vite plugin connects that build to the Worker deployment. [Vite: deploying a static site](https://vite.dev/guide/static-deploy.html) [Cloudflare: React + Vite](https://developers.cloudflare.com/workers/framework-guides/web-apps/react/)

## SQL persistence and migrations

Bind one D1 database as `DB`. The Worker can use D1's typed binding API and prepared statements directly. Cloudflare recommends binding values to prepared statements, which also prevents SQL injection. This is enough for the proof of concept; an ORM would add a second schema and migration layer without a current need. [Cloudflare D1: Workers Binding API](https://developers.cloudflare.com/d1/worker-api/) [Cloudflare D1: prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)

Keep each schema change as an ordered, committed `.sql` file under `migrations/`. Wrangler records applied migration names in D1 and can create, list, and apply the remaining migrations. If applying one fails, that migration is rolled back and earlier successful migrations remain applied. [Cloudflare D1: migrations](https://developers.cloudflare.com/d1/reference/migrations/) [Cloudflare D1: Wrangler migration commands](https://developers.cloudflare.com/d1/wrangler-commands/#d1-migrations-apply)

Local and production D1 data are separate. Apply and test migrations locally first, then apply the same files to the remote database deliberately. Do not point normal local development at production data; Cloudflare warns that remote changes cannot be undone. [Cloudflare D1: local development](https://developers.cloudflare.com/d1/best-practices/local-development/)

## Access and identity boundary

For the proof of concept, keep the generated `workers.dev` URL. Cloudflare describes it as suitable for personal or hobby projects and lets the Worker be protected from its **Settings > Domains & Routes** page. Configure an Access Allow policy for François's exact email, not an email domain. [Cloudflare: manage access to workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/#manage-access-to-workersdev) [Cloudflare: Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)

Access checks requests for a valid `CF_Authorization` cookie, but the Worker API must still validate the signed JWT from the `Cf-Access-Jwt-Assertion` header. Validation must check the signature, issuer, and application audience (`aud`) against Cloudflare's rotating public keys. Missing configuration or an invalid token must fail closed. Cloudflare's Worker example uses `jose`; this is the one security dependency the proof of concept should not replace with hand-written cryptography. [Cloudflare: authorization cookie](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/) [Cloudflare: validate Access JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

The application does not need its own user table or an owner column in phase one. The Access policy admits one person, and all rows belong to that one private dataset. This keeps Access as the gate without pretending it is the future product's account system.

Do not use the Access `sub` claim as a permanent phase-two account ID. Cloudflare says `sub` is unique to an email within one Zero Trust account, but it changes if the person is removed and re-added or uses another organization. The token's `email` is identity-provider verified, but it is still an email rather than a durable application-owned ID. When phase two adds real accounts, create the app-owned user, add ownership columns in a D1 migration, and assign all existing proof-of-concept rows to François. [Cloudflare: Access application token claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/#payload)

## Build-time checklist

1. Start from Cloudflare's current React scaffold without deploying it.
2. Add Hono in the existing Worker entry point, not as another app.
3. Add the D1 binding and plain SQL migrations.
4. Make every data route pass through JWT validation.
5. Deploy once to `workers.dev`, enable Access, and restrict the policy to the exact allowed email.
6. Verify both the UI and `/api/*` reject a signed-out request, and verify signed-in data survives a redeploy.

## Remaining uncertainty

- The Cloudflare account's current Zero Trust team domain, identity provider, allowed email, and Access audience tag were not inspected. They are deployment values, not architecture choices.
- Local Vite development does not sit behind the deployed Access application. The implementation needs one explicit local-only way to exercise API routes while production continues to fail closed; the smallest safe mechanism should be chosen during the build.
- Personal-data export or backup remains a separate product-scope choice. D1's existence does not decide whether it belongs in this proof of concept.
