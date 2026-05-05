import { readFileSync } from 'node:fs';
import 'dotenv/config';

type ParsedCard = {
  displayName: string;
  primaryEmail?: string;
  emails: string[];
  phones: string[];
  birthday?: string;
  notes?: string;
};

function unfold(raw: string): string {
  return raw.replace(/\r?\n[ \t]/g, '');
}

function unescape(v: string): string {
  return v.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function splitProperty(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [rawName = '', ...paramParts] = head.split(';');
  const params: Record<string, string> = {};
  for (const p of paramParts) {
    const eq = p.indexOf('=');
    if (eq < 0) params[p.toUpperCase()] = '';
    else params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name: rawName.toUpperCase(), params, value };
}

function parseCard(block: string): ParsedCard | null {
  const lines = block.split(/\r?\n/);
  let displayName = '';
  const emails = new Set<string>();
  const phones = new Set<string>();
  let birthday: string | undefined;
  let notes: string | undefined;

  for (const line of lines) {
    if (!line || line.startsWith('BEGIN:') || line.startsWith('END:')) continue;
    const prop = splitProperty(line);
    if (!prop) continue;
    if (prop.name === 'PHOTO' || prop.name === 'X-IMAGE' || prop.name.startsWith('X-AB')) continue;
    switch (prop.name) {
      case 'FN':
        displayName = unescape(prop.value).trim();
        break;
      case 'EMAIL': {
        const v = prop.value.trim().toLowerCase();
        if (v && /.+@.+\..+/.test(v)) emails.add(v);
        break;
      }
      case 'TEL': {
        const v = prop.value.trim();
        if (v) phones.add(v);
        break;
      }
      case 'BDAY':
        birthday = prop.value.trim();
        break;
      case 'NOTE':
        notes = unescape(prop.value).trim();
        break;
    }
  }

  if (!displayName) return null;
  const emailList = [...emails];
  return {
    displayName,
    primaryEmail: emailList[0],
    emails: emailList,
    phones: [...phones],
    birthday,
    notes: notes || undefined,
  };
}

function parseAll(raw: string): ParsedCard[] {
  const unfolded = unfold(raw);
  const blocks = unfolded.split(/BEGIN:VCARD/i).slice(1);
  const out: ParsedCard[] = [];
  for (const b of blocks) {
    const end = b.search(/END:VCARD/i);
    const body = end >= 0 ? b.slice(0, end) : b;
    const card = parseCard(body);
    if (card) out.push(card);
  }
  return out;
}

function buildPayload(card: ParsedCard): Record<string, unknown> {
  const p: Record<string, unknown> = { displayName: card.displayName };
  if (card.primaryEmail) p.primaryEmail = card.primaryEmail;
  if (card.emails.length) p.emails = card.emails;
  if (card.phones.length) p.phones = card.phones;
  if (card.birthday) p.birthday = card.birthday;
  if (card.notes) p.notes = card.notes;
  return p;
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: tsx scripts/import-vcards.ts <path-to.vcf>');
    process.exit(1);
  }
  const apiKey = process.env.KIZUNA_API_KEY;
  if (!apiKey) {
    console.error('KIZUNA_API_KEY not set in env');
    process.exit(1);
  }
  const baseUrl = process.env.KIZUNA_API_URL ?? 'http://127.0.0.1:3000';

  const raw = readFileSync(file, 'utf8');
  const cards = parseAll(raw);
  console.log(`parsed ${cards.length} contacts from ${file}`);

  let ok = 0;
  let conflict = 0;
  let bad = 0;
  const failures: { name: string; status: number; body: string }[] = [];

  for (const card of cards) {
    const payload = buildPayload(card);
    const res = await fetch(`${baseUrl}/v1/people`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      ok++;
    } else if (res.status === 409) {
      conflict++;
    } else {
      bad++;
      const body = await res.text();
      failures.push({ name: card.displayName, status: res.status, body: body.slice(0, 200) });
    }
  }

  console.log(`ok=${ok} conflict=${conflict} failed=${bad}`);
  if (failures.length) {
    console.log('first failures:');
    for (const f of failures.slice(0, 5)) {
      console.log(`  - ${f.name}: ${f.status} ${f.body}`);
    }
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
