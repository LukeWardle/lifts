# Current Project State

**LAST UPDATED:** 15 September 2026  
**UPDATED BY:** [CODEX]  
**CURRENT ITERATION:** 8 complete — bounded photo upload streaming  
**CURRENT OBJECTIVE:** Final system audit and Claude review of remaining architectural risks.  
**SYSTEM STATUS:** Backend tests pass; offline cardio, structural plan validation and bounded gzip decoding in both plan and result paths are protected. Deployment to GitHub Pages remains manual.  
**WHAT CURRENTLY WORKS:** Deterministic planning/progression, Postgres persistence, offline lift/cardio logging, email import/export, multi-week cardio packs, structural validation and bounded plan decoding.  
**WHAT CURRENTLY DOES NOT WORK:** Multi-device/account sync, authenticated hosted operation, plan-version history, browser end-to-end tests, server-side product authentication, and a formal photo/privacy workflow.  
**RECENT MAJOR CHANGES:** Week-spanning cardio plans; active-week PWA selection; plan contract validator; compressed/expanded payload limits; cache version v4.  
**CURRENT BEST HYPOTHESES:** The next foundational risk is one-pack local storage without a plan ID/version/history; this can make an imported replacement plan opaque and unrecoverable.  
**RECENTLY REJECTED HYPOTHESES:** The Week 2 issue was not loss of logged cardio; it was omission of future-week prescriptions from the offline pack.  
**BIGGEST UNKNOWNS:** Exact desired cross-device/version policy; hosted authentication/data-retention architecture; operational deployment path.  
**HIGHEST-PRIORITY PROBLEMS:** Plan version/history integrity; end-to-end offline/PWA coverage; server authentication before public deployment; sensitive-photo governance.  
**NEXT RECOMMENDED EXPERIMENT:** Trace replacement-plan import, result watermarking and local state retention to determine a minimally compatible plan identity/version contract.  
**QUESTIONS REQUIRING OTHER-MODEL REVIEW:** Is a portable offline plan snapshot sufficient as the plan identity, or should the backend issue stable plan/version IDs before multi-device work begins?

# Codex Review

**Status:** Iterations 1–2 complete — cardio persistence and offline plan-contract validation tested.

**Update (15 September 2026):** The missing `strength-tracker` backend was located
at `C:\Users\lward\workspace\strength-tracker` and is now included in the review.
It contains the Python planner, Postgres migrations, phone packer/importer and 1,012
automated tests. The initial statement that these systems were absent applies only to
the original `lifts-site` workspace.

**Scope inspected (15 September 2026):** every tracked source file, service worker,
manifest, README, two commits, local persistence and plan-import paths. The repository
contains a small static PWA only. It is explicitly described by its README as the
offline phone half of a system; the laptop-side exercise library, plan generation,
progression rules and import tooling are not present.

## Current Application Assessment

### What is here and working

- A dependency-free responsive PWA, installable via `manifest.webmanifest`, with a
  network-first/offline service worker.
- A browser-only state store (`localStorage`, key `lifts:v1`) containing one imported
  plan pack, completed lifting sessions, cardio bouts, weigh-ins and local email address.
- Import/export codecs using JSON + gzip + base64url. A plan arrives in a URL fragment
  and results are shared as a compressed text block. Fragments are not sent in HTTP
  requests, which is a useful minimisation property.
- Gym-session logging: readiness, exercise substitutions, target-set fallback,
  rest timer and progress export. The DOM helper inserts text via `textContent`, not
  HTML, which reduces DOM-XSS risk from plan content.
- Cardio logging with machine settings and an optional current-week display when the
  imported pack contains a `cardio` object.
- Progress-photo selection is passed to the platform share sheet; image bytes are not
  deliberately saved by this PWA.

### What is absent (not merely incomplete)

There is no backend, database, authentication, server API, AI/API integration, image
analysis, account model, exercise database (only a pack-supplied subset), persistent
central plan history, plan-generation algorithm, validation schema, observability,
deployment configuration, test suite or laptop-side importer/generator. Consequently,
the repository cannot substantiate claims about a 12-month plan, personalised AI
generation, photo assessment, commercial subscriptions or a multi-device product.

This is a valid prototype architecture for an offline personal tracker, but not yet an
architecture for the commercial platform described in the project brief.

## Cardio Investigation

### Evidence and data flow observed

`plan link fragment → decodeCode → loadPack → state.pack → renderCardio`.

- `loadPack` accepts only `v: 1` and an array of `sessions`; it does **not** validate
  `cardio`, `week_start`, `days`, dates, targets or machine metadata.
- `renderCardio` displays the weekly prescription only from `state.pack.cardio`.
  It never generates cardio, and it cannot infer week 2 from week 1.
- `cardioForm` uses `pack.cardio.days` only to prefill today's minutes. It always
  permits a manual cardio entry.
- Completed bouts persist in local storage. When a new pack declares
  `imported_through`, `forgetImported` deliberately removes already-imported local
  cardio from the phone, while the new pack is expected to carry aggregate
  `done_minutes` and the next prescription.
- The current UI filters prescribed days to `date >= trainingDate()`. That hides past
  planned sessions, intentionally or otherwise; it does not explain a missing future
  week.

### Confirmed root cause

`strength_tracker.phone.build_pack()` plans several upcoming lifting sessions, which
can cross a Monday, but serialised only one `cardio` object for the week containing
the pack date. The PWA retained that pack offline; in Week 2, its only cardio dates
were in the past and `renderCardio` filtered them out. Lifting remained available,
but the cardio prescription appeared to disappear. Logged cardio itself was not lost.

### Fix and regression protection

- The packer now emits `cardio_weeks`, containing a persisted prescription for every
  calendar week reached by an included offline session. It retains `cardio` for
  backward compatibility with the current deployed PWA.
- The PWA now resolves cardio by training-date/week from `cardio_weeks`, falling back
  safely to the legacy one-week field. Its week strip, today's cardio prompt and
  cardio screen all use that resolver.
- Added `test_cardio_covers_every_week_reached_by_offline_sessions`, which builds an
  eight-session pack and asserts that every session week has a matching cardio week.
- Bumped the PWA service-worker cache to `lifts-v3`, so deployed users receive the
  JavaScript that understands the new field.

## Research Findings

### Training and adaptation

- **Fact:** Weekly resistance-training volume shows a dose-response association with
  hypertrophy, but the appropriate dose is individual rather than a universal target.
  [Schoenfeld et al., systematic review/meta-analysis](https://pubmed.ncbi.nlm.nih.gov/27433992/)
- **Fact:** With matched volume, a range of loads can support hypertrophy; higher loads
  favour maximal-strength gains. [Lopez et al., systematic review/meta-analysis](https://pubmed.ncbi.nlm.nih.gov/35015560/)
- **Fact:** Autoregulation has plausible value for individualising daily training, but
  evidence does not justify an opaque AI making large autonomous changes from a single
  readiness score. [Mann et al., systematic review/meta-analysis](https://pubmed.ncbi.nlm.nih.gov/35038063/)
- **Recommendation:** Model a programme as a versioned sequence of *delivery windows*
  (normally 1–4 weeks) with explicit goal, constraints, progression rules and review
  checkpoints. A long-horizon intent may be represented as phases, but do not promise
  or pre-generate a fixed 12-month calendar. Deterministic rules should validate
  volume, frequency, equipment, time budget, progression caps and contraindication
  gates; an LLM may propose structured content but must not be the source of truth.
- **Recommendation:** Start adaptation conservatively: collect completion, achieved
  repetitions/load/RIR or RPE, session difficulty, missed sessions and recovery
  feedback. Make small, explainable adjustments only after repeat signals; surface
  a proposed change to the user. This preserves the user's selected goal—including
  Strongman—while flagging risks rather than silently substituting a different goal.

### Safety, photos and privacy

- **Fact:** Health information is special-category data under UK GDPR. Digital photos
  are not automatically biometric special-category data, but technical processing for
  unique identification is. [ICO guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/special-category-data/what-is-special-category-data/)
- **Recommendation:** Do not ship image-based body-fat percentages as measurements.
  If photos are ever accepted, require an explicit, separate purpose/consent flow,
  clear uncertainty wording, deletion controls, minimal retention and a documented
  data-protection impact assessment. Keep identity/face recognition out of scope.
- **Recommendation:** Keep the product on general training guidance. Add screening and
  escalation routes for symptoms, injury, pregnancy, cardiovascular conditions,
  medication concerns and eating-disorder signals; it must not diagnose or provide
  clinical treatment.

### Product direction (initial)

**Inference:** Retain the offline-first PWA as a useful training-floor companion, but
position it as a companion to a secure service—not as the primary record. The smallest
commercially credible next architecture is a responsive web/PWA with authenticated,
versioned server-side programmes; native apps can follow only when push notifications,
camera workflow or offline sync show validated demand.

**Recommendation:** The differentiator cannot be “AI plans.” It should be trustworthy
continuity: explainable progression based on actual logged performance, equipment and
time constraints, easy substitutions, offline operation and transparent safety/privacy
boundaries. Test pricing only after this reliable loop exists; market comparisons and
unit economics require a separate current-price research pass.

## Problems Identified

1. **Critical scope mismatch:** the required source systems are absent from this
   workspace, so they cannot be audited or safely changed here.
2. **High — unvalidated plan input:** only `v` and `sessions` are validated. Malformed
   `cardio`, session/exercise structures or dates can cause incorrect rendering or
   runtime errors.
3. **High — plan/history integrity:** one `state.pack` overwrites the previous imported
   pack. There is no plan ID/version or immutable history; any central continuity is
   delegated to unavailable laptop tooling.
4. **High — data loss risk:** browser storage is the only record. Clearing site data or
   losing a device loses unsent work; multiple phones can conflict, as README notes.
5. **Medium — no test or fixture harness:** there is no regression protection for plan
   import, cardio, export or offline behaviour.
6. **Medium — no observability:** failures are either shown as a transient toast or
   silently ignored (including service-worker registration); no safe diagnostic event
   trail exists.
7. **Medium — wording is too strong:** "Two low scores in a row ... asks Claude to look
   at your plan" suggests an adaptation loop that this repository does not implement.
8. **Medium — share-sheet photo workflow:** the app itself does not retain photos, but
   its privacy posture depends on the chosen receiving application; there is no consent
   or retention explanation for that recipient.
9. **Low — cache deployment risk:** service-worker cache names must be manually bumped;
   an accidental omission can leave users on stale application code.

## Changes Made

- Added this handover document.
- Updated `strength-tracker/src/strength_tracker/phone.py` to include cardio coverage
  for every week included in an offline pack.
- Added the cardio cross-week regression test in `strength-tracker/tests/test_phone.py`.
- Updated `lifts-site/app.js` to select the active week's cardio prescription and
  `lifts-site/sw.js` cache version to deploy it.

## Changes Rejected

- Rewriting this PWA into a backend product: unjustified without the existing laptop
  source, data contract and a migration decision.
- Adding AI, image-analysis, authentication or payments to this static repository:
  unsupported by the current system boundary and safety/privacy review.
- Fabricating a cardio fix without a reproducible Week 2 payload.

## Tests Performed

- `node --check app.js` — passed (syntax only).
- `python -m pytest tests/test_cardio.py tests/test_phone.py -q` — **56 passed**.
- Full backend suite: `python -m pytest -q` — **1,012 passed**.
- `git diff --check` — passed.
- Static trace of cardio data from decoded plan through render, local persistence,
  export and pack-import cleanup; plan-packer/importer code and Git history inspected.

Pytest emitted two non-failing warnings because the sandbox prevented updates to
`.pytest_cache`; these do not affect test execution.

## Open Questions

1. What is the intended authoritative store and plan version/identity model when the
   product moves beyond one laptop and one phone?
2. Is photo analysis a product requirement or a testing-only workflow? If product,
   what lawful basis, processor, retention period and deletion path are proposed?
3. Should future cardio prescriptions be fixed when an offline pack is issued (current
   behaviour), or should the product require a sync before a new week? The former is
   appropriate for offline use but should be visible as a plan version.

## Recommendations

1. Define a versioned JSON schema before broader UI work: `plan_id`, `version`, delivery
   dates/timezone, explicit weekly cardio decision, sessions, validation metadata and
   import watermark. Validate it on producer and client.
3. Add an end-to-end browser test that loads a cross-week pack and advances the mocked
   date into Week 2; the backend contract regression now protects the root cause.
4. Make server-side programme history and privacy/safety design the prerequisite for
   commercial features. Keep current PWA's offline cache and quick logging interactions
   where they remain valuable.

## Claude Review Requested

Please inspect this file before making further architecture decisions. In particular,
review whether locking a Week 2 cardio target into the offline pack is the desired
product policy and propose the authoritative plan/version store. Please distinguish
confirmed behaviour from assumptions in the next handover update.

## Next Iteration

Iteration 3: audit the plan/version data model and periodisation representation across
the actual Postgres schema and planner. It should decide whether future delivery
windows, plan versions and adaptations are represented safely enough for a multi-user
commercial product.

# Codex Findings Awaiting Claude Review

## [CODEX] Offline plan contract — implemented

**CLAIM:** A compressed plan link is an untrusted application boundary and must be
validated before it is written to local storage or rendered.

**EVIDENCE:** Prior code accepted any decoded object containing only `v: 1` and a
`sessions` array. Downstream code assumes IDs, ISO dates, exercise targets and cardio
properties without checks. [OWASP's input-validation guidance](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)
recommends early allowlist validation with type/range/format limits.

**FILES:** `strength-tracker/phone/contract.js`, `phone/app.js`, `phone/index.html`,
`phone/sw.js`; mirrored in `lifts-site/`.

**TESTS:** `node phone/tests/contract.test.mjs` passes valid data and rejects invalid
session IDs, zero-minute cardio and empty exercise lists.

**UNCERTAINTIES:** This is client-side resilience/UX validation, not a security
substitute for server-side validation when a hosted service exists. The current contract
is intentionally compatibility-preserving and does not yet require a plan ID/version.

**QUESTION FOR CLAUDE:** Can you identify a legitimate pack shape this allowlist would
reject, especially no-weight/bodyweight sessions or a planned zero-cardio week?

**STATUS:** IMPLEMENTED — awaiting independent review.

# Claude Findings Awaiting Codex Verification

No unverified Claude findings are currently recorded. Claude's repository-location
correction was verified against `C:\Users\lward\workspace\strength-tracker` and accepted.

# Questions for Claude

1. Can you falsify the claim that offline packs require a stable plan/version identity
   before supporting multiple devices or plan history?
2. Does the new client contract exclude any valid existing phone pack? Please test it
   against a real redacted pack if available.

# Questions / Tasks for Codex

1. [OPEN] Audit replacement-plan import and result watermark behaviour for history/data
   loss before proposing a plan-version contract.

# Active Disagreements

None recorded. The cross-week cardio root cause was independently confirmed in the
backend code and protected by regression test.

# Collaboration Iteration 2

**OWNER:** [CODEX]

**OBJECTIVE:** Make the offline plan-link boundary fail visibly and early for malformed
or incomplete plan data.

**WHY THIS WAS PRIORITISED:** A plan governs physical activity. Previously, malformed
data could be accepted into local storage and crash or misrender only after a user had
arrived at a gym. This is a foundational reliability and safety boundary.

**RESEARCH QUESTION:** What minimum validation is appropriate for an offline,
compressed JSON plan link without adding a build dependency?

**RESEARCH / SOURCES:** OWASP recommends early, allowlist validation of structure,
types, ranges, dates and finite data values; client checks complement rather than
replace server checks. Source above. Evidence quality: authoritative secure-development
guidance, not fitness research; directly applicable to the import boundary.

**HYPOTHESIS:** A dependency-free structural validator can reject malformed packs while
leaving legitimate legacy packs usable.

**IMPLEMENTATION:** Added `contract.js`, loaded before `app.js`; validated sessions,
exercises, set targets, cardio prescriptions and duplicate IDs/weeks before saving.
Added an executable Node test. Added the asset to the service-worker precache and
bumped its cache version. Mirrored all PWA changes into the backend's canonical
`phone/` directory.

**FILES CHANGED:** `strength-tracker/phone/{contract.js,app.js,index.html,sw.js,tests/contract.test.mjs}`;
the matching publishable files in `lifts-site/`.

**TESTS:** `node phone/tests/contract.test.mjs` — passed; `node --check` for changed
JavaScript — passed; `git diff --check` — passed. The earlier full Python suite remains
at 1,012 passing tests; this iteration changed no Python runtime code.

**RESULT / MEASUREMENT:** Four previously unchecked classes of malformed data now have
explicit bounds/shape checks before persistence: session identity/date, exercise/set
targets, cardio prescription, and duplicate weekly data. The included regression suite
demonstrates three invalid pack classes are rejected and a valid multi-week pack passes.

**FAILURES / REJECTED IDEAS:** A version-2 hard break that required `cardio_weeks` was
rejected for now because already-issued one-week links must remain usable. A formal JSON
Schema dependency was rejected: this tiny static PWA has no build chain and the explicit
validator is testable with its existing runtime.

**REMAINING UNCERTAINTIES:** The client cannot prove producer correctness or secure a
public hosted product. It also has no persistent plan identity/history.

**RECOMMENDED NEXT STEP:** Iteration 3 plan/replacement integrity audit.

**STATUS:** COMPLETE.

# Final System Audit

**Architecture:** The deterministic Python planner, Postgres model and isolated pure
modules are strong foundations. The offline PWA is a deliberate companion, not a
multi-user product architecture.

**Plan contracts / state:** Cross-week cardio coverage, structural link validation,
strict dates and bounded decompression are now protected. The unresolved material risk
is the lack of explicit plan-delivery version/history and multi-device reconciliation.

**Training / safety:** Cardio and resistance logic are extensively unit-tested; photo
assessment remains constrained to relative muscle emphasis and excludes body-fat or
medical claims. Automation should remain conservative because individual response,
injury status and recovery cannot be inferred reliably.

**Privacy / security:** Upload bytes, type, dimensions and pose are now validated.
Photos remain locally stored unless assessment is requested. No authentication exists;
the API must remain private as README states. Hosted deployment is blocked on auth,
authorisation, retention/deletion controls and a DPIA.

**Offline/PWA:** Cache v4 contains the new contract asset. The remaining PWA gaps are
browser end-to-end testing, storage-quota handling, data backup/recovery and an update
notification flow.

**Testing:** Final run: **1,019 Python tests passed**, plus Node phone-contract tests,
JavaScript syntax and diff checks. Pytest cache-write warnings are sandbox-only and
non-failing.

**Highest-value Iteration 9:** Add an explicit plan delivery/version identity and test
replacement, stale delivery, result watermark and recovery behaviour across two devices.

# Commercialisation Research — [CODEX] In Progress

**Question:** What monetisation can be tested credibly in the UK without claiming that
generic AI plans are worth a premium?

**Evidence:** Fitbod publicly lists $15.99/month or $95.99/year and a 7-day trial, with
offline workouts, equipment support and tracking. [Fitbod FAQ](https://fitbod.me/faqs/)
Apple Fitness+ is £9.99/month or £79.99/year in the UK. [Apple](https://www.apple.com/uk/apple-fitness-plus/)
Freeletics has a free basic tier and a paid personalised Coach. [Freeletics](https://help.freeletics.com/hc/en-us/articles/360004928220-Is-the-app-free)
Stripe UK standard-card processing is 1.5% + £0.20 per successful transaction.
[Stripe](https://stripe.com/gb/pricing)

**Working decision:** Test web-first freemium, not payment implementation: free workout
logging and a time-limited sample plan; paid tier at £8.99/month or £69.99/year for
versioned adaptive programmes, progression explanations, offline packs and full plan
history. Do not charge extra for image assessment; keep it optional and conservative.

**Unit-economics implication:** At £8.99/month, a standard UK card fee is about £0.33,
leaving £8.66 before hosting, support, tax, acquisition and AI. Therefore AI cost is not
the primary viability question at current bounded use; paid retention and support burden
are. This is a pre-launch hypothesis, not a forecast.

**Required validation before billing:** instrument activation (first completed session),
week-4 retention, paid conversion, support time and actual per-active-user API/storage
cost. Authentication, plan identity and deletion controls remain prerequisites.

# Collaboration Iteration 6

**OWNER:** [CODEX]

**OBJECTIVE:** Ensure the local photo-upload endpoint stores actual supported images,
rather than trusting a client-provided MIME type.

**WHY THIS WAS PRIORITISED:** Photos are sensitive personal data and later may be sent
to an external assessment service. The endpoint had a 25 MB byte cap but accepted any
bytes labelled as JPEG/PNG/WebP/HEIC.

**RESEARCH:** The ICO privacy conclusion from the initial audit remains: minimise photo
processing and do not represent photo outputs as measurement. The security decision is
also consistent with [OWASP input validation guidance](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html): validate type and content early, not a client declaration alone.

**IMPLEMENTATION:** Added `vision.validate_upload_image`, which decodes image bytes via
Pillow, requires actual format to match the declared type, calls `verify()`, and rejects
dimensions above 40 million pixels. The API calls it before creating a path or DB row.

**FILES CHANGED:** `strength-tracker/src/strength_tracker/{vision.py,api.py}` and
`tests/test_vision.py`.

**TESTS:** `pytest tests/test_vision.py tests/test_library.py -q` — 53 passed. Real JPEG
bytes pass; arbitrary bytes and JPEG declared as PNG fail.

**RESULT:** MIME spoofing and non-image bytes no longer reach local photo storage.

**UNCERTAINTIES:** HEIC acceptance now depends on the installed Pillow image plugin.
That is intentionally fail-safe but needs device compatibility review. Authentication is
still absent; README correctly states this endpoint must not be public.

**QUESTION FOR CLAUDE:** Challenge the 40-megapixel cap and HEIC policy. Is fail-closed
HEIC decoding acceptable for the testing product, or is a transparent user-side
conversion path necessary before public release? Also identify any image-decompression
or metadata risk this check misses.

**STATUS:** COMPLETE — CLAUDE REVIEW REQUESTED.

# Collaboration Iteration 7

**OWNER:** [CODEX]

**OBJECTIVE:** Prevent malformed photo pose values from expanding vision-assessment scope.

**DISCOVERY:** Unknown pose values previously fell back to the explicit `other` pose and
allowed every muscle to be rated. That contradicted the design rule that unobservable
muscles must not be guessed.

**IMPLEMENTATION / TEST:** Added an API pose allowlist; made unknown poses yield no
visible muscles; added an unknown-pose regression. Focused suite: 54 passed.

**RESULT:** Only an explicit `other` pose can use its broad scope; malformed input fails
closed.

**STATUS:** COMPLETE.

# Collaboration Iteration 8

**OWNER:** [CODEX]

**OBJECTIVE:** Ensure the 25 MB upload limit is enforced during reading, not after an
unbounded multipart body has already been accumulated.

**IMPLEMENTATION:** Replaced single `await file.read()` with 1 MB chunked reads and a
running limit. Added unit tests for normal collection and a 25 MB+1 rejection.

**TESTS:** `pytest tests/test_api_uploads.py tests/test_vision.py -q` — 6 passed.

**RESULT:** Oversized photos are stopped after at most one additional read chunk instead
of being fully buffered by application code.

**STATUS:** COMPLETE.

# Collaboration Iteration 5

**OWNER:** [CODEX]

**OBJECTIVE:** Falsify the plan-link date validator with malformed calendar dates.

**DISCOVERY:** The initial format check plus `Date.parse` accepted rollover values such
as `2026-02-31`, which JavaScript normalizes to March rather than rejecting.

**IMPLEMENTATION:** The validator now round-trips the parsed UTC date back to the
original ISO date. Added a regression assertion for `2026-02-31` and mirrored the fix
to the publishable PWA.

**TESTS:** Node contract tests passed; full Python suite passed — **1,013 passed**.

**RESULT:** Invalid calendar dates now fail at import instead of becoming a different
training date silently.

**STATUS:** COMPLETE.

# Collaboration Iteration 4

**OWNER:** [CODEX]

**OBJECTIVE:** Bound gzip expansion for results pasted into the laptop importer.

**WHY THIS WAS PRIORITISED:** The PWA plan decoder was bounded in Iteration 3, but
Python's `gzip.decompress` still expanded phone-result input in full. The same malformed
or accidental oversized payload could therefore affect the importing side.

**HYPOTHESIS:** Reading at most 1 MB plus one byte through `gzip.GzipFile` rejects
oversized decoded results without affecting valid imports.

**IMPLEMENTATION:** Added encoded and expanded-size limits in
`strength_tracker.phone.decode`; retained existing corruption messaging and made the
safe-size error explicit. Added a regression test with a highly compressible result
payload larger than the decoded limit.

**TESTS:** `python -m pytest tests/test_phone.py -q` — 13 passed; diff check passed.

**RESULT:** Both directions of the offline exchange now enforce a 200,000-character
compressed-input limit and a 1 MB expanded-JSON limit before parsing/persistence.

**UNCERTAINTY:** Limits require real-size observations before production deployment;
no user pack/result-size telemetry currently exists.

**QUESTION FOR CLAUDE:** Please challenge whether 1 MB permits the largest realistic
phone result after a long offline interval, and provide measured evidence if it does not.

**STATUS:** COMPLETE.

# Collaboration Iteration 3

**OWNER:** [CODEX]

**OBJECTIVE:** Prevent an oversized compressed plan link from consuming unbounded phone
memory before its contents can be validated.

**WHY THIS WAS PRIORITISED:** The offline plan is received as an untrusted gzip payload
in a URL fragment. The former decoder expanded it wholesale using `Response(...).text()`;
a small compressed input could therefore expand before the validator had any chance to
run.

**RESEARCH / SOURCES:** [OWASP input-validation guidance](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)
supports early format and length limits. This is general application-security guidance;
the precise 200,000-character / 1,000,000-byte limits are an engineering guardrail,
not a claim about an industry-standard plan size.

**HYPOTHESIS:** Streaming decompression with explicit compressed and expanded-size caps
will preserve ordinary plan loading while failing oversized inputs visibly.

**IMPLEMENTATION:** Moved bounded decoding into the dependency-free phone contract
module. It limits encoded fragments to 200,000 characters and expanded JSON to 1 MB,
cancels oversized streams and returns a user-facing error. The app calls it before
structural validation. The change is mirrored in the publishable PWA and canonical
backend phone directory.

**FILES CHANGED:** `lifts-site/{contract.js,app.js}` and matching
`strength-tracker/phone/{contract.js,app.js,tests/contract.test.mjs}`.

**TESTS:** Contract suite passed a valid gzip round trip and rejected a payload that
inflates beyond 1 MB. JavaScript syntax and diff checks passed.

**FAILURES:** The first test compared objects across Node VM realms and failed despite
identical structure. The test was corrected to compare serialized JSON; the decoder was
not changed because the failure did not reproduce in product code.

**RESULT / MEASUREMENT:** The decoder now has two explicit resource bounds before JSON
parsing; oversized plan links fail before local persistence or rendering.

**REMAINING UNCERTAINTIES:** The limits need telemetry/real pack-size observation before
any commercial rollout. This does not solve plan version/history or browser-storage loss.

**QUESTION FOR CLAUDE:** Is the 1 MB expanded limit comfortably above the largest real
pack, including a full exercise library? If not, provide a measured redacted pack size.

**RECOMMENDED NEXT STEP:** Audit local state lifecycle and plan replacement identity.

**STATUS:** COMPLETE.
