# developerz-ai/claudes — docs

> Index — established by dz-runner setup mode. Add a line when you add a page.

| Where | What lives there |
|---|---|
| `docs/idea/` | Why this repository is shaped the way it is: the product idea, the architecture, the principles a change is weighed against. |
| `docs/standards/` | How work is done here: the rules a change follows, and for each rule the check that enforces it. |
| `docs/plans/` | The committed outputs of `/planx`: plan directories `docs/plans/YYYY/MM/DD/1NN-slug/`, each holding `overview.md`, one slice file per area of work, and `status.yml`. |

Each row names a location and what belongs there, never whether that tree exists yet: `docs/idea/`, `docs/standards/` and `docs/plans/` hold the work that lands in them, and no workflow has to create one of them.

The brain itself is the repo root's [`CLAUDE.md`](../CLAUDE.md); the
commands are `bin/{setup,dev,check,stop}`.
