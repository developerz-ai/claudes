# developerz-ai/claudes — docs

> Index — established by dz-runner setup mode. Add a line when you add a page.

| Where                                                                                 | What lives there                                                                                                                                                      |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/idea/`                                                                          | Why this repository is shaped the way it is: the product idea, the architecture, the principles a change is weighed against.                                          |
| `docs/standards/`                                                                     | How work is done here: the rules a change follows, and for each rule the check that enforces it.                                                                      |
| `docs/plans/`                                                                         | The committed outputs of `/planx`: plan directories `docs/plans/YYYY/MM/DD/1NN-slug/`, each holding `overview.md`, one slice file per area of work, and `status.yml`. |
| `docs/plans/2026/11/24/101-wrap-profiles-dynamic-models/overview.md`                  | Plan 101: the audited bug list, the facts the design rests on, the decisions and the slice order.                                                                     |
| `docs/plans/2026/11/24/101-wrap-profiles-dynamic-models/01-gate.md`                   | Plan 101, slice 1: a gate that is green on a developer machine and hermetic.                                                                                          |
| `docs/plans/2026/11/24/101-wrap-profiles-dynamic-models/02-wrap-passthrough.md`       | Plan 101, slice 2: subcommands reach `claude` intact; off-router modes are refused.                                                                                   |
| `docs/plans/2026/11/24/101-wrap-profiles-dynamic-models/03-profiles.md`               | Plan 101, slice 3: named profiles, so one install can use several routers.                                                                                            |
| `docs/plans/2026/11/24/101-wrap-profiles-dynamic-models/04-dynamic-models.md`         | Plan 101, slice 4: `/model`, tiers, context windows and the key check from the router at launch.                                                                      |
| `docs/plans/2026/11/24/101-wrap-profiles-dynamic-models/05-settings-file-lifetime.md` | Plan 101, slice 5: settings files named by content instead of by pid.                                                                                                 |
| `docs/plans/2026/11/24/101-wrap-profiles-dynamic-models/06-doctor.md`                 | Plan 101, slice 6: doctor's isolation, key-copy cleanup and verdicts.                                                                                                 |
| `docs/plans/2026/11/24/101-wrap-profiles-dynamic-models/status.yml`                   | Plan 101: the tracker.                                                                                                                                                |

Each row names a location and what belongs there, never whether that tree exists yet: `docs/idea/`, `docs/standards/` and `docs/plans/` hold the work that lands in them, and no workflow has to create one of them.

The brain itself is the repo root's [`CLAUDE.md`](../CLAUDE.md); the
commands are `bin/{setup,dev,check,stop}`.
