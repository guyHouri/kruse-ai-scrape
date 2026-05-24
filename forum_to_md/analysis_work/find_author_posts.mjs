import fs from "node:fs";
import path from "node:path";

const root = path.resolve("processed_mds", "threads");
const authorArg = process.argv[2] || "";
const authorNeedle = /^ALL$/i.test(authorArg) ? "" : authorArg.toLowerCase();
const cue = new RegExp(process.argv[3] || "cancer|DDW|deuterium|clinic|patient|client|protocol|oncolog|tumou?r", "i");

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

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

function finishPost(post, hits, file) {
  if (!post) return;
  if (authorNeedle && !post.author.toLowerCase().includes(authorNeedle)) return;
  const ownText = stripMarkdown(post.ownLines.join(" "));
  const fullText = stripMarkdown(post.lines.join(" "));
  if (!cue.test(ownText) && !cue.test(fullText)) return;
  hits.push({
    file,
    author: post.author,
    source: post.source,
    ownText: ownText.slice(0, 1200),
    fullText: fullText.slice(0, 1200),
  });
}

const hits = [];
for (const file of walk(root)) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  let post = null;
  for (const line of lines) {
    const heading = line.match(/^###\s+(.+?)\s+.*?\d{4}-\d{2}-\d{2}T/);
    if (heading) {
      finishPost(post, hits, file);
      post = { author: stripMarkdown(heading[1]), source: "", lines: [], ownLines: [] };
      continue;
    }
    if (!post) continue;
    const source = line.match(/^\*\*Source:\*\*\s+<([^>]+)>/);
    if (source) post.source = source[1];
    post.lines.push(line);
    if (!line.trimStart().startsWith(">")) post.ownLines.push(line);
  }
  finishPost(post, hits, file);
}

console.log(JSON.stringify({ hits: hits.length, examples: hits.slice(0, 80) }, null, 2));
