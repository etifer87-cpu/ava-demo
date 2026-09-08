# AGENTS.md

Read `CLAUDE.md` in this directory. It is the full brief for an agent working in this scaffold:
the read order, the invariants (ids not names, `element_key` not row id, TEXT grades, thresholds in
config, the deterministic core computes and the model narrates, soft delete, no operator identity,
capability-gated elements are not rendered), the verification commands, and the house style.

Two things to know before you open anything else:

- `../docs/` is the authority. Where the scaffold and a doc disagree, the doc is right.
- Do not claim something works until `npm run typecheck`, `npm run migrate`, the seeds,
  `npm run smoke` and `npm run test` have actually run. A 200 is not proof.
