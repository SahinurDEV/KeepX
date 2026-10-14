import { NextResponse, type NextRequest } from "next/server";

const prefixes = ["/inbox", "/today", "/upcoming", "/tasks", "/completed", "/calendar", "/search", "/lists", "/tags", "/settings"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const needsAuth = prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  if (!needsAuth || request.cookies.get("vela_session")) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/inbox",
    "/inbox/:path*",
    "/today",
    "/today/:path*",
    "/upcoming",
    "/upcoming/:path*",
    "/tasks",
    "/tasks/:path*",
    "/completed",
    "/completed/:path*",
    "/calendar",
    "/calendar/:path*",
    "/search",
    "/search/:path*",
    "/lists/:path*",
    "/tags",
    "/tags/:path*",
    "/settings",
    "/settings/:path*",
  ],
};
