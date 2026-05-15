import { readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

export async function deleteStaleBySlug(dir, slug) {
  const re = new RegExp(`^website-${escapeRe(slug)}-\\d{4}-\\d{2}-\\d{2}\\.md$`);
  let entries;
  try {
    entries = await readdir(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
  let deleted = 0;
  for (const name of entries) {
    if (re.test(name)) {
      await unlink(path.join(dir, name));
      deleted++;
    }
  }
  return deleted;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
