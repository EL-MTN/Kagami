"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, checkApiKey, makeSessionToken } from "./session";

export async function loginAction(formData: FormData): Promise<void> {
  const raw = formData.get("key");
  const key = typeof raw === "string" ? raw : "";
  if (!checkApiKey(key)) {
    redirect("/login?error=1");
  }
  const c = await cookies();
  c.set(SESSION_COOKIE, makeSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" || process.env.KIZUNA_COOKIE_SECURE === "true",
    path: "/",
    maxAge: 30 * 86_400,
  });
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  const c = await cookies();
  c.delete(SESSION_COOKIE);
  redirect("/login");
}
