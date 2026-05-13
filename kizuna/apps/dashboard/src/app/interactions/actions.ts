"use server";

import { api } from "@/lib/api";
import type { Person } from "@/lib/types";

export type PersonPickerResult = {
  id: string;
  displayName: string;
  primaryEmail: string | null;
};

export async function searchPeopleAction(query: string): Promise<PersonPickerResult[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const res = await api.listPeople({ query: trimmed, limit: 8 });
  return res.items.map((p: Person) => ({
    id: p.id,
    displayName: p.displayName,
    primaryEmail: p.primaryEmail,
  }));
}
