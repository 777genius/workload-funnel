# Changesets

Add a changeset for every user-visible package change. Packages remain private
during Phase 0, but version history starts now so the later public transition
does not need to reconstruct releases.

Run `pnpm changeset`, select the affected package, and describe the behavior a
consumer will observe. Tooling-only changes do not need a changeset.
