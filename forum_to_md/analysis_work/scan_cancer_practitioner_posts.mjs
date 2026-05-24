import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve("D:/kruse/guy export/forum_to_md");
const THREAD_DIR = path.join(ROOT, "processed_mds", "threads");
const OUT = path.join(ROOT, "analysis_work", "cancer_practitioner_post_hits.json");

const CANCER_RE =
  /\b(?:cancers?|oncolog(?:y|ist|ical)?|tumou?rs?|malignan(?:t|cy)?|metasta(?:sis|tic|sized)?|carcinoma|sarcoma|lymphoma|leuk(?:a)?emia|myeloma|melanoma|glioblastoma|glioma|chemo(?:therapy)?|radiation|radiotherapy|remission|neoplasm|precancer(?:ous)?|mastectomy|lumpectomy|BRCA|NED|biopsy|immunotherapy|stage\s+(?:I{1,3}|IV|[1-4])\b|cancer markers?)\b/i;

const KRUSE_RE =
  /\b(?:DDW|deuterium|deuterium depleted|deuterium depletion|Preventa|Qlarivia|Litewater|Hydro[- ]?Health|10\s?ppm|25\s?ppm|50\s?ppm|sunrise|sunlight|UV\b|UVA|UVB|infrared|IR-A|red light|photobiomodulation|PBM|grounding|earthing|nnEMF|EMF|blue light|blue blockers?|circadian|chrono-?chemo|chrono-?therapy|melatonin|cold thermogenesis|\bCT\b|epi-?paleo|seafood|DHA|ketogenic|paleolithic ketogenic|PKD|mitochondria|mitochondrial|redox|quantum|magnetism|caldera|tropics|low tech|no light after sunset)\b/i;

const PROFESSIONAL_RE =
  /\b(?:Dr\.?|doctor|physician|surgeon|oncologist|naturopath|clinic|center|centre|hospital|institute|medical|practitioner|patients?|my practice|our practice|my clinic|our clinic|cancer clinic|acupuncture clinic|Paleomedicina|Gerson|Block Center|Makis|Gordon|Somlyai|Boros|Seyfried|Clemens|Brownstein|Flechas|Marik|Myhill|Klinghardt|Gerson|Hope4Cancer)\b/i;

function stripMarkdown(value) {
  return String(value || "")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[*_`>#]+/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function extractNames(text, author) {
  const names = new Set();
  const clean = stripMarkdown(text);
  for (const match of clean.matchAll(/\bDr\.?\s+(?:[A-Z][A-Za-z'.-]+|[A-Z]\.)(?:\s+(?:[A-Z][A-Za-z'.-]+|[A-Z]\.)){0,4}/g)) {
    names.add(match[0].replace(/\s+/g, " ").trim());
  }
  for (const match of clean.matchAll(/\b([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,4}),?\s+(M\.?D\.?|D\.?O\.?|N\.?D\.?|D\.?C\.?|Ph\.?D\.?)\b/g)) {
    names.add(`${match[1]} ${match[2]}`.replace(/\s+/g, " ").trim());
  }
  for (const match of clean.matchAll(/\b([A-Z][A-Za-z0-9&'.-]+(?:\s+(?:of|and|the|for|[A-Z][A-Za-z0-9&'.-]+)){0,8}\s+(?:Cancer\s+)?(?:Clinic|Clinics|Center|Centre|Institute|Hospital|Medical|Therapy|Therapeutics|Health|Paleomedicina))\b/g)) {
    names.add(match[1].replace(/\s+/g, " ").trim());
  }
  for (const known of [
    "Block Center",
    "Keith Block",
    "John Gordon",
    "Dr John Gordon",
    "Dr. John Gordon",
    "Dr Makis",
    "Dr. Makis",
    "Paleomedicina",
    "Zsofia Clemens",
    "Gabor Somlyai",
    "Somlyai",
    "Laszlo Boros",
    "Lazlo Boros",
    "Thomas Seyfried",
    "Gerson clinic",
    "AcuHealth",
    "Puna Wai Ora Mind-Body Cancer Clinic",
    "David Brownstein",
    "Jorge Flechas",
    "Dr Marik",
    "Paul Marik",
    "Dr Rohen Kapur",
    "Rohen Kapur",
  ]) {
    if (new RegExp(`\\b${known.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(clean)) names.add(known);
  }
  if (/(my clinic|our clinic|my practice|our practice|acupuncture clinic|referred patients|my patients|cancer clinic|stage 4 cancer patients)/i.test(clean)) {
    names.add(`${author} (forum practitioner lead)`);
  }
  return [...names].filter((name) => name.length >= 3 && name.length < 120);
}

const hits = [];
let posts = 0;
for (const file of listFiles(THREAD_DIR)) {
  const rel = path.relative(ROOT, file).replaceAll(path.sep, "/");
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  let post = null;
  function finish() {
    if (!post) return;
    posts += 1;
    const own = stripMarkdown(post.ownLines.join(" ")).slice(0, 3000);
    const full = stripMarkdown(post.lines.slice(0, 80).join(" ")).slice(0, 3000);
    const haystack = `${own} ${full}`;
    const lower = haystack.toLowerCase();
    if (!/(cancer|tumor|tumour|oncolog|carcinoma|glioblastoma|glioma|lymphoma|leukemia|melanoma|chemo|radiation|mastectomy|stage 4|cancer markers)/i.test(lower)) return;
    if (!/(ddw|deuterium|sun|uv|infrared|red light|grounding|emf|circadian|chrono|cold|ct|keto|ketogenic|mitochond|redox|quantum|magnet|caldera|tropics)/i.test(lower)) return;
    if (!/(dr|doctor|physician|surgeon|oncologist|clinic|center|centre|hospital|institute|medical|practitioner|practice|patients|paleomedicina|gerson|block|makis|gordon|somlyai|boros|seyfried|clemens|brownstein|flechas|marik|myhill|klinghardt|hope4cancer)/i.test(lower)) return;
    if (!CANCER_RE.test(haystack) || !KRUSE_RE.test(haystack) || !PROFESSIONAL_RE.test(haystack)) return;
    const names = extractNames(haystack, post.author);
    if (!names.length) return;
    hits.push({
      file: rel,
      author: post.author,
      source: post.source,
      names,
      own_text: own.slice(0, 1400),
      context: haystack.slice(0, 2200),
    });
  }
  for (const line of lines) {
    const heading = line.match(/^###\s+(.+?)\s+.*?\d{4}-\d{2}-\d{2}T/);
    if (heading) {
      finish();
      post = { author: stripMarkdown(heading[1]), source: "", lines: [], ownLines: [] };
      continue;
    }
    if (!post) continue;
    const source = line.match(/^\*\*Source:\*\*\s+<([^>]+)>/);
    if (source) post.source = source[1];
    post.lines.push(line);
    if (!line.trimStart().startsWith(">")) post.ownLines.push(line);
  }
  finish();
}

const byName = new Map();
for (const hit of hits) {
  for (const name of hit.names) {
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const row = byName.get(key) || { name, count: 0, files: new Set(), examples: [] };
    row.count += 1;
    row.files.add(hit.file);
    if (row.examples.length < 6) row.examples.push(hit);
    byName.set(key, row);
  }
}

const candidateSummary = [...byName.values()]
  .map((row) => ({ ...row, files: [...row.files] }))
  .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

fs.writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), posts_scanned: posts, hits: hits.length, candidates: candidateSummary }, null, 2));
console.log(JSON.stringify({ out: OUT, posts_scanned: posts, hits: hits.length, candidates: candidateSummary.length, top: candidateSummary.slice(0, 30).map((r) => ({ name: r.name, count: r.count })) }, null, 2));
