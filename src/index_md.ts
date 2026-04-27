import fs from 'node:fs/promises';
import { listEntityIds, readEntity } from './entity_io.js';
import { paths } from './paths.js';

export async function rebuildIndex(): Promise<void> {
  const ids = await listEntityIds();
  const entries = await Promise.all(ids.map((id) => readEntity(id)));
  entries.sort((a, b) =>
    a.frontmatter.name.localeCompare(b.frontmatter.name),
  );

  const lines = ['# Memory Index', ''];
  for (const { frontmatter: fm } of entries) {
    const aliases =
      fm.aliases.length > 0 ? ` — aliases: ${fm.aliases.join(', ')}` : '';
    lines.push(`- [[${fm.id}]] — ${fm.type} — ${fm.name}${aliases}`);
  }
  lines.push('');

  await fs.mkdir(paths.vault, { recursive: true });
  await fs.writeFile(paths.index, lines.join('\n'));
}
