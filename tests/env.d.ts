import type { D1Migration } from "cloudflare:test";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {
    LOCAL_DEV: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}
