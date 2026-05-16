# Private modules

Some modules in this project consume content with sensitive copyright / ToS posture (Patreon mirrors, paid feeds, etc.) and live in **separate private repositories** rather than in this public repo. They are attached as **git submodules**, so the directory exists in the working tree on your machine, but the public repo only stores a pointer to the private commit hash.

A contributor without access to the private repo simply gets an empty `kemono_to_md/` directory after cloning — the public scrapers all still build and run fine without it.

---

## Current private modules

| Module | Why private | Private repo |
|---|---|---|
| [`kemono_to_md/`](kemono_to_md/) | Patreon mirror scraper. The Kemono service itself is a piracy aggregator; even though Jack Kruse is the original copyright holder of the content, redistributing a scraper preset that explicitly targets a piracy aggregator in a public repo is a poor look and a likely DMCA target. | `git@github.com:guyHouri/kruse-ai-scrape-kemono.git` *(create when first using)* |

---

## One-time setup — create the private repo (repo owner only)

If the private repo doesn't exist yet:

1. On GitHub: **New repository** → name `kruse-ai-scrape-kemono` → **Private** → no README/license/gitignore (we already have one in the working tree).
2. On your machine, push the existing `kemono_to_md/` directory as its own repo root:

   ```sh
   cd "D:/kruse/guy export/kemono_to_md"
   git init
   git add .
   git commit -m "Initial import — kemono_to_md from kruse-ai-scrape"
   git branch -M main
   git remote add origin git@github.com:guyHouri/kruse-ai-scrape-kemono.git
   git push -u origin main
   ```

3. From the public repo root, register it as a submodule:

   ```sh
   cd "D:/kruse/guy export"
   # the directory already exists locally, so use --force
   git submodule add --force git@github.com:guyHouri/kruse-ai-scrape-kemono.git kemono_to_md
   git add .gitmodules
   git commit -m "Add kemono_to_md as private submodule"
   git push
   ```

4. **Remove `kemono_to_md/` from `.gitignore`** once it's a submodule — submodules need to be tracked at the pointer level. Replace the `kemono_to_md/` line with a comment noting it's a submodule.

---

## Contributor workflow — cloning the public repo

Without access to the private repo (most contributors):

```sh
git clone https://github.com/guyHouri/kruse-ai-scrape.git
cd kruse-ai-scrape
# kemono_to_md/ stays empty — public scrapers (forum, linkedin, free_blogs, etc.) all work without it
```

With access to the private repo (you / approved collaborators):

```sh
git clone --recurse-submodules git@github.com:guyHouri/kruse-ai-scrape.git
# OR if already cloned without submodules:
git submodule update --init --recursive
```

---

## Why submodule and not just a separate repo entirely?

We considered three options:

1. **Two unrelated repos** — clean separation, but you lose the single-clone "all of Jack's content" story.
2. **Monorepo with private folder** — impossible, GitHub privacy is per-repo not per-folder.
3. **Public repo + private submodule** ← chosen. Single clone for users with access, clean public face for everyone else, separate access control via the private repo.

The submodule pointer in the public repo only reveals the *existence* of the private module and its commit hash — not any of the code or content. Anyone without read access on the private repo can't resolve the pointer.

---

## Rolling the private module forward

When you update kemono_to_md:

```sh
cd kemono_to_md
# ... make changes ...
git add . && git commit -m "..." && git push

cd ..
git add kemono_to_md         # this commits the new submodule pointer
git commit -m "Bump kemono_to_md pointer"
git push
```

---

## Future modules that might go private

Anticipated, not built yet:

- `qa_rag/audio/` and `qa_rag/transcripts/raw/` — see FUTURE_IMPROVEMENTS.md #2. Transcripts of paid Patreon Q&A specifically. The pipeline code can stay public; the actual audio/transcripts go in a private storage bucket OR private submodule.
- `weekly_updater/processed_mds/patreon/` — same reason. Patreon delta extracts can live in a private submodule alongside kemono.

Both are deferred — flag here so they're not forgotten when those modules ship.
