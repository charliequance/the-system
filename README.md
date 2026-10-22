# The System

A Solo Leveling-style daily quest tracker. Installable web app (PWA), data in Supabase with row-level security, so only the signed-in owner can read or write their rows. Based on [The System](https://github.com/JSheard3/the-system) by JSheard3.

- `index.html`: the whole app
- `config.js`: Supabase project URL + publishable key (safe to be public; RLS guards the data)
- `sw.js`: offline shell (bump `VERSION` on every change so phones pick it up)

Quests, main quests, gates, rewards and sales targets live in the owner's private `system/config` row, not in this repo.
