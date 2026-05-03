import { Types } from 'mongoose';
import { errors } from './errors.js';

export function encodeCursor(id: Types.ObjectId | string): string {
  const hex = typeof id === 'string' ? id : id.toHexString();
  return Buffer.from(hex, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): Types.ObjectId {
  let hex: string;
  try {
    hex = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw errors.badRequest('invalid cursor');
  }
  if (!/^[a-f0-9]{24}$/i.test(hex)) {
    throw errors.badRequest('invalid cursor');
  }
  return new Types.ObjectId(hex);
}
