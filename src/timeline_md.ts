import fs from 'node:fs/promises';
import {
  listEntityIds,
  parseObservations,
  readEntity,
} from './entity_io.js';
import { paths } from './paths.js';

interface TimelineRow {
  effectiveDate: string;
  headline: string;
  entityId: string;
  entityName: string;
}

// Builds timeline.md by scanning every entity, parsing each observation, and
// sorting by effective date (event_date if present, else conversation date).
// Always-loaded by retrieval to give the model a chronological view of the
// vault — directly addresses temporal-reasoning questions that would
// otherwise require multi-entity traversal.
export async function rebuildTimeline(): Promise<void> {
  const ids = await listEntityIds();
  const rows: TimelineRow[] = [];
  for (const id of ids) {
    const { frontmatter, body } = await readEntity(id);
    for (const obs of parseObservations(body)) {
      rows.push({
        effectiveDate: obs.event_date || obs.date,
        headline: obs.headline,
        entityId: frontmatter.id,
        entityName: frontmatter.name,
      });
    }
  }

  rows.sort((a, b) => {
    if (a.effectiveDate !== b.effectiveDate) {
      return a.effectiveDate.localeCompare(b.effectiveDate);
    }
    return a.entityName.localeCompare(b.entityName);
  });

  const lines = ['# Timeline', ''];
  for (const r of rows) {
    lines.push(`- ${r.effectiveDate} — ${r.headline} [[${r.entityId}]]`);
  }
  lines.push('');

  await fs.mkdir(paths.vault, { recursive: true });
  await fs.writeFile(paths.timeline, lines.join('\n'));
}
