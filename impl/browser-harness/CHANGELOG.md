# @anon-rpc/browser-harness changelog

Changes to this package by version. Specification changes are in the
[specification changelog](https://github.com/ethereum/anon-rpc/blob/main/CHANGELOG.md);
this package implements the spec version named in its README.

## 0.3.3 — 2026-10-13

Implements spec 0.3.2 (unchanged).

- **Fixed: worker bundles load on Firefox.** Firefox refuses `importScripts(blob:)`
  in a worker whose origin is opaque — which §6 makes the harness's worker — even
  for a blob the worker created itself and even when a CSP allows `blob:`
  (measured on Firefox 140 and 157). The worker runtime now probes with an empty
  blob script and, where that is refused, imports the verified bundle as a
  `data:` URL instead, with the same classic-script semantics. Other browsers
  keep using `blob:`. Probing first, rather than retrying after a failure, means
  a bundle whose top level throws is never run twice.
- **Integrators with a bootstrap page under a strict CSP** (`iframeUrl`): on
  Firefox, allow `data:` in that page's `script-src` wherever a policy applies
  there. Chromium needs no change.

Earlier releases are recorded in the specification changelog and the git
history.
