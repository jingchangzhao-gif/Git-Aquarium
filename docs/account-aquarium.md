# The account aquarium

Decisions behind issue #38: the Projects mode can fill its tank from the GitHub CLI account that is
already signed in on this machine, shows how each project is being maintained, and lets the owner set a
project to **finished** explicitly.

## Decisions

1. **One account, one tank.** "My account" reads the account `gh` is signed into on this machine. There is
   no input for a login name: the command line is the only source of identity, so the page never has to
   ask for, store, or transmit credentials.
2. **Only what the owner published.** The account endpoint returns repositories where `owner.login` is the
   signed-in account and `visibility` is `public`, without forks. Private repositories, organizations, and
   repositories the account merely collaborates on are out of scope.
3. **The token never reaches the browser.** `gh` runs as a child of the Vite dev server. The page receives
   only whitelisted public fields (`full_name`, `name`, `description`, `html_url`, `created_at`,
   `pushed_at`, `archived`, `topics`, `fork`) and a login name. No token is put in the page, a URL, local
   storage, a dataset file, or the logs.
4. **The hosted build stays static.** Pages has no server to ask, so `/api/account` and `/api/finished`
   exist only in `pnpm dev` and `pnpm preview`. On the hosted site the "My account" button reports that the
   local endpoint is missing instead of pretending to read an identity.
5. **Upkeep is a clock, not a judgement.** Activity comes from `pushed_at` and is deterministic:

   | Days since the last push | Lifecycle | Form | Speed |
   | --- | --- | --- | --- |
   | 0 to 90 | `active` | fish | 1 |
   | 91 to 179 | `slowing` | fish | falls linearly from 1 to 0.2 |
   | 180 to 365 | `seaweed` | seaweed | 0 |
   | over 365, or archived | `rock` | rock | 0 |
   | no `pushed_at` | `unknown` | fish | 0.4 |

   A missing date is shown as unknown, never guessed. Quiet months are never reported as finished.
6. **Finished is a setting.** A project is finished only when its repository carries the
   `aquarium-finished` topic. The owner of the project picks the form with `aquarium-form-fish`,
   `aquarium-form-seaweed`, or `aquarium-form-rock` (default: fish). The topic overrides every time rule,
   including archival.
7. **Writing needs an explicit click, and shows what it costs.** The panel shows an editor only for
   repositories the signed-in account owns. A confirmation names the repository and the topics before the
   request; the endpoint checks ownership again, keeps unrelated topics, and on any failure leaves the
   repository's topics unchanged and says why.
8. **Every failure is visible.** A repository that cannot be read is named in the data boundaries and left
   out; the rest of the tank still loads. A missing `gh`, a signed-out CLI, a rate limit, and a refused
   topic write each have their own message.

## Boundaries

- The tank is not a health score, a productivity metric, or a prediction. A fish is a design choice for
  one repository's pull requests and issues, as the tank already says.
- "Finished" describes what the owner declared, not what the activity suggests.
- Reading costs three requests per repository (pulls, issues, and one search for the issue total).
  Without a token GitHub allows 60 requests an hour, so an account tank of twelve repositories can take
  most of a fresh allowance.
- The account tank is limited to twelve repositories, the most recently pushed first, like a typed tank.
- Topic names are public GitHub metadata; the panel warns that saving changes it.

## Out of scope

- Organizations, private repositories, and repositories the account only contributes to.
- A server for the hosted build, a stored token, or OAuth inside the page.
- Any change to the aquarium's geometry (issue #39) or to interaction beyond this panel (issue #40).

## Acceptance in this change

- `src/account.ts` has unit tests for the whitelist, the payload, the newest-first cap, the finished
  override, the missing-CLI message, and the write request.
- `src/projects.test.ts` covers every lifecycle boundary (90, 91, 180, 365, 366), archival, a missing date,
  the finished override, and a topic change that keeps unrelated topics.
- The demo tank now shows each form, including one project that is finished by topic.
- The panel shows the lifecycle, speed, quiet days, and — for an owned project — the finished editor.
