# Hosted demo and shareable aquariums

Status: accepted for the next cut. Issue #9. A static build, no server, no stored credentials.

## Problem

Seeing the aquarium today takes a clone and `pnpm dev`. Nobody outside the project will do that,
and there is no address to send anyone.

## Decisions

1. **Publish to GitHub Pages from `main`.** A workflow builds the existing static bundle and deploys
   it on every push to `main`, plus a manual trigger. No server is introduced, and nothing about the
   simulation changes.

2. **Default `github.io` path, no custom domain.** The production build uses base `/Git-Aquarium/`;
   `pnpm dev` stays at `/`. A custom domain is an owner-side change later and needs no code beyond
   setting the base.

3. **Pages has to be enabled once by the owner** (Settings -> Pages -> Source: GitHub Actions). A
   workflow cannot enable Pages for the repository, so the README says so next to the deploy section.

4. **Shareable links are query parameters:** `?repo=owner/name&seed=1`.
   - `repo` is validated with the same pattern the import uses; an invalid value is ignored rather
     than fetched.
   - `seed` must be a non-negative integer; anything else falls back to the field's default.
   - When a recorded dataset is loaded, or the seed changes, the URL is rewritten with
     `history.replaceState`, so the address bar is always shareable and no history entries pile up.
   - The synthetic demo keeps whatever link brought the visitor there: a demo is not a repository.

5. **The hosted build has no model endpoint.** The Ecologist answers by rule and already labels that
   ("No language model is configured, so fixed rules wrote this from the recorded readings"). This is
   the intended hosted behaviour, not a degradation to hide. Imports may use the optional GitHub token
   added for issue #8; it stays in tab memory and is not included in shared links.

6. **Scheduled image or loop rendering in an Action is out of this cut.** It needs WebGL under
   software rendering, which is the uncertain part, and it is separable from publishing. A 2D renderer
   for the image is the recorded fallback; a test of headless software WebGL is the first step if it
   is picked up. Until then, **Save picture** in the corner of the tank saves the current view as a
   PNG by hand, which covers a README image that does not need to update itself.

## Boundaries stated in the app and README

- The hosted app is static: no server or model key, and no saved visitor data. A user may enter an
  optional GitHub token for an import; it stays in tab memory and never enters the URL.
- A link reproduces an import only while GitHub still serves the same records. A saved dataset file is
  the reproducible unit; a link is a convenience.
- An import from a link spends the same requests as a typed import (40 of the unauthenticated 60 an
  hour), so a shared busy repository may be partially covered and says so.
- Pages serves static files; the model endpoint exists only in `pnpm dev` and `pnpm preview`.

## Acceptance

- A push to `main` publishes the app at `https://<owner>.github.io/Git-Aquarium/` once Pages is
  enabled, with assets loading from that base.
- `?repo=owner/name&seed=3` opens on that repository and seed; an invalid `repo` opens the demo.
- Loading a dataset or changing the seed updates the address bar without adding history entries.
- The Ecologist answers by rule on the hosted build and says so.
