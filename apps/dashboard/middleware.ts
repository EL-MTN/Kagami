import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;

  // If no password is set, allow all requests (dev convenience)
  if (!password) return NextResponse.next();

  const authHeader = request.headers.get("authorization");

  if (authHeader) {
    const [scheme, encoded] = authHeader.split(" ");
    if (scheme === "Basic" && encoded) {
      // atob is available in Edge Runtime
      const decoded = atob(encoded);
      // Only the password portion is checked. Slice from the first colon so
      // passwords containing colons aren't truncated (split(":") would only
      // capture up to the second colon).
      const colonIdx = decoded.indexOf(":");
      const pwd = colonIdx === -1 ? "" : decoded.slice(colonIdx + 1);
      if (pwd === password) {
        return NextResponse.next();
      }
    }
  }

  return new NextResponse("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Kokoro Dashboard"',
    },
  });
}

export const config = {
  matcher: [
    // Match all routes except static assets and Next.js internals
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
