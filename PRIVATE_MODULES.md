# Private modules

Some modules and data in this project have a sensitive copyright / ToS posture (Patreon mirrors, paid audio transcripts, etc.) and live in a **separate private repository** rather than in this public repo.

They're attached as **one git submodule at `private/`** mapped to `kruse-ai-scrape-private`. The public repo only stores a pointer to the private commit hash — anyone without access to the private repo gets an empty `private/` directory after cloning, and all public scrapers (forum, linkedin, free_blogs, etc.) build and run fine without it.

---

## Layout

```
kruse-ai-scrape/                          public repo
├── forum_to_md/                          public
├── linkedin_to_md/                       public
├── free_blogs_md/                        public
├── private/                              ← submodule → kruse-ai-scrape-private
│   ├── README.md
│   ├── .gitignore
│   ├── kemono_to_md/                     Patreon mirror scraper
│   ├── qa_rag/             (future)      Q&A audio → transcripts → RAG (see FUTURE_IMPROVEMENTS §2)
│   └── weekly_updater/patreon/  (future) Weekly Patreon delta extracts
└── …
```

| Module | Why private |
|---|---|
| `private/kemono_to_md/` | Kemono is a piracy aggregator; even though Jack Kruse holds the original copyright, redistributing a scraper targeting that domain in a public repo is a DMCA target. |
| `private/qa_rag/` *(future)* | Paid Patreon Q&A audio + transcripts. Pipeline code can stay public; raw audio + transcripts stay private. |
| `private/weekly_updater/patreon/` *(future)* | Weekly Patreon delta extracts. Same reason. |

---

## Contributor workflow

### Without access to the private repo (most contributors)

```sh
git clone https://github.com/guyHouri/kruse-ai-scrape.git
cd kruse-ai-scrape
# private/ stays empty — submodule init will fail with 403, ignore.
# public scrapers (forum_to_md, linkedin_to_md, free_blogs_md) all work without it.
```

### With access (project owner + approved collaborators)

```sh
git clone --recurse-submodules https://github.com/guyHouri/kruse-ai-scrape.git
# OR after a plain clone:
git submodule update --init --recursive
```

---

## Updating the private module

Edit files inside `private/`, then:

```sh
cd private
git add . && git commit -m "..." && git push

cd ..
git add private              # bumps the submodule pointer in the public repo
git commit -m "Bump private pointer"
git push
```

The public repo records *only the new commit hash*, not the actual changes — no private content leaks.

---

## Why one submodule (not one per private module)?

Considered: separate submodule per private module (`kemono_to_md` + `qa_rag` + …). Rejected because:

- More moving parts → more places to forget to push / pull.
- All private modules share the same access list anyway (project owner).
- Single submodule = single private repo = single PAT/SSH key to rotate when secrets leak.

If a future module ever needs different access control, split then.

---

## What the public repo reveals

The public repo's `.gitmodules` discloses:

- The private repo's URL (`https://github.com/guyHouri/kruse-ai-scrape-private.git`).
- The current commit hash the public repo is pinned to.

It does **NOT** disclose any private file contents, structure, names, or sizes. A 403 on the private repo URL means nothing more than "this is a private repo, ask for access" — same surface area as referencing it in a README.
