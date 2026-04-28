import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isVaultPath } from '../src/query.ts';

test('isVaultPath accepts entities/ and raw/ paths', () => {
  assert.equal(isVaultPath('entities/typescript.md'), true);
  assert.equal(isVaultPath('raw/2026-04-27-1430.md'), true);
});

test('isVaultPath rejects path traversal', () => {
  assert.equal(isVaultPath('entities/../../../etc/passwd'), false);
  assert.equal(isVaultPath('raw/../foo.md'), false);
  assert.equal(isVaultPath('..'), false);
});

test('isVaultPath rejects absolute paths', () => {
  assert.equal(isVaultPath('/etc/passwd'), false);
  assert.equal(isVaultPath('/Users/x/secrets'), false);
});

test('isVaultPath rejects other top-level prefixes', () => {
  assert.equal(isVaultPath('_core.md'), false);
  assert.equal(isVaultPath('index.md'), false);
  assert.equal(isVaultPath('.memory/log.jsonl'), false);
  assert.equal(isVaultPath('.git/config'), false);
});

test('isVaultPath rejects empty and non-strings', () => {
  assert.equal(isVaultPath(''), false);
  // @ts-expect-error intentional invalid type
  assert.equal(isVaultPath(undefined), false);
  // @ts-expect-error intentional invalid type
  assert.equal(isVaultPath(null), false);
});

test('isVaultPath rejects null bytes', () => {
  assert.equal(isVaultPath('entities/\0evil.md'), false);
});
