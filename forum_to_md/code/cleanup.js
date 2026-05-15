// Wipe stale processed_mds/forum-jackkruse-*.md before writing today's output.
// Mirrors website_to_md/code/cleanup.js but with a forum-specific filename
// pattern (one master MD per run, dated).

import { readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const FORUM_MD_RE = /^forum-jackkruse-\d{4}-\d{2}-\d{2}\.md$/;

export async function deleteStaleForumMds(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
  let deleted = 0;
  for (const name of entries) {
    if (FORUM_MD_RE.test(name)) {
      await unlink(path.join(dir, name));
      deleted++;
    }
  }
  return deleted;
}
