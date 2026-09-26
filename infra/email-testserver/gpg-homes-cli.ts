import { provisionGpgHomes } from "./gpg-homes.ts";

// Child-process entry point for `provisionGpgHomesInChildProcess`: prints
// the provisioned homes as JSON and deliberately does *not* clean up — the
// parent owns the homes from here on and removes them itself.
const provisioned = provisionGpgHomes(process.argv.slice(2));
console.log(
  JSON.stringify({
    homes: [...provisioned.homes],
    fingerprints: [...provisioned.fingerprints],
  }),
);
