"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useScroll, useMotionValueEvent } from "motion/react";
import { Home, LayoutDashboard, LogOut, Menu, X } from "lucide-react";
import { useAuth } from "@/lib/hooks/useAuth";
import { getToken, setToken } from "@/lib/auth-storage";
import LoginDialog from "@/components/LoginDialog";
import { safeNextPath } from "@/lib/navigation/safe-next-path";

/* ── Route nav items ── */
const NAV_ITEMS = [
  { label: "首页", href: "/home", type: "route" as const },
  { label: "核心功能", href: "#capabilities", type: "section" as const },
  { label: "应用场景", href: "#scenarios", type: "section" as const },
  { label: "技术架构", href: "#technology", type: "section" as const },
  { label: "文档", href: "/docs", type: "route" as const },
];

const SCROLL_THRESHOLD = 180;

function getSafeNextPath() {
  if (typeof window === "undefined") return "/dashboard";
  return safeNextPath(new URLSearchParams(window.location.search).get("next"));
}

function clearLoginQuery() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete("login");
  url.searchParams.delete("next");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

const Navbar = () => {
  const pathname = usePathname();
  const { scrollY } = useScroll();
  const { user, logout, loading: authLoading, error: authError } = useAuth();

  const isHomePage = pathname === "/home";
  const [scrolled, setScrolled] = useState(false);
  const scrolledRef = useRef(false);
  const [currentHash, setCurrentHash] = useState("");

  /* ── Login dialog ── */
  const [showLoginDialog, setShowLoginDialog] = useState(false);
  /* ── User dropdown ── */
  const [showMenu, setShowMenu] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);

  useEffect(() => {
    if (!showMenu) return;
    const closeUserMenu = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowMenu(false);
    };
    window.addEventListener("keydown", closeUserMenu);
    return () => window.removeEventListener("keydown", closeUserMenu);
  }, [showMenu]);

  useMotionValueEvent(scrollY, "change", (v) => {
    if (!isHomePage) return;
    const shouldBeScrolled = scrolledRef.current
      ? v > SCROLL_THRESHOLD - 30
      : v > SCROLL_THRESHOLD;
    if (shouldBeScrolled !== scrolledRef.current) {
      scrolledRef.current = shouldBeScrolled;
      setScrolled(shouldBeScrolled);
    }
  });

  useEffect(() => {
    const next = isHomePage ? window.scrollY > SCROLL_THRESHOLD : false;
    const frame = requestAnimationFrame(() => {
      if (next !== scrolledRef.current) {
        scrolledRef.current = next;
        setScrolled(next);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [isHomePage]);

  useEffect(() => {
    if (typeof window === "undefined" || authLoading) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("login") !== "1") return;
    if (user) {
      const frame = requestAnimationFrame(() => {
        const token = getToken();
        if (token) setToken(token);
        window.location.replace(getSafeNextPath());
      });
      return () => cancelAnimationFrame(frame);
    }
    const frame = requestAnimationFrame(() => setShowLoginDialog(true));
    return () => cancelAnimationFrame(frame);
  }, [authLoading, pathname, user]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const syncHash = () => setCurrentHash(window.location.hash || "");
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, [pathname]);

  /* Non-home pages: always show solid background */
  const showSolidBg = !isHomePage || scrolled;

  /* ── Hover sliding indicator ── */
  const containerRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hovIdx, setHovIdx] = useState<number | null>(null);

  const activeIdx = NAV_ITEMS.findIndex((item) => {
    if (item.type === "route") {
      return pathname === item.href;
    }
    return isHomePage && currentHash === item.href;
  });

  const handleSectionNavigation = useCallback((href: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (typeof window === "undefined") return;

    if (isHomePage) {
      event.preventDefault();
      const target = document.querySelector(href);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        window.history.replaceState(null, "", `/home${href}`);
        setCurrentHash(href);
      }
    }
  }, [isHomePage]);

  const moveIndicator = useCallback((idx: number | null) => {
    const ind = indicatorRef.current;
    const container = containerRef.current;
    if (!ind || !container) return;

    const targetIdx = idx ?? activeIdx;
    const el = targetIdx >= 0 ? itemRefs.current[targetIdx] : null;

    if (!el) {
      ind.style.opacity = "0";
      return;
    }
    const cr = container.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    ind.style.transform = `translate(${er.left - cr.left}px, ${er.top - cr.top}px)`;
    ind.style.width = `${er.width}px`;
    ind.style.height = `${er.height}px`;
    ind.style.opacity = "1";
  }, [activeIdx]);

  useEffect(() => {
    moveIndicator(hovIdx);
  }, [hovIdx, activeIdx, moveIndicator, scrolled]);

  useEffect(() => {
    const handler = () => moveIndicator(hovIdx);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [hovIdx, moveIndicator]);

  const onMouseEnter = (i: number) => {
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
    setHovIdx(i);
  };

  const onMouseLeave = () => {
    leaveTimer.current = setTimeout(() => setHovIdx(null), 180);
  };

  const handleWorkspaceNavigation = useCallback((event: React.MouseEvent<HTMLAnchorElement | HTMLButtonElement>) => {
    event.preventDefault();

    if (authLoading) return;
    if (!user) {
      setShowLoginDialog(true);
      return;
    }

    // Refresh the auth cookie before navigating so middleware can see the session.
    const token = getToken();
    if (!token) {
      setShowLoginDialog(true);
      return;
    }
    setToken(token);
    window.location.assign("/dashboard");
  }, [authLoading, user]);

  return (
    <>
      {/* Login dialog — rendered at top level so it works on every page */}
      <LoginDialog
        open={showLoginDialog}
        onClose={() => {
          setShowLoginDialog(false);
          clearLoginQuery();
        }}
        onSuccess={() => {
          setShowLoginDialog(false);
          window.location.assign(getSafeNextPath());
        }}
      />

      <nav className="fixed top-0 left-0 right-0 z-50 flex justify-center pointer-events-none">
        {/* ── Bar — all transitions via CSS ── */}
        <div
          className="relative flex items-center justify-center pointer-events-auto"
          style={{
            height: 56,
            width: scrolled ? "fit-content" : "100%",
            borderRadius: scrolled ? 9999 : 0,
            padding: scrolled ? "5px 8px" : "0 40px",
            marginTop: scrolled ? 12 : 0,
            boxShadow: scrolled
              ? "0 4px 24px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.05)"
              : "none",
            transition: "all 0.45s cubic-bezier(0.25, 1, 0.5, 1)",
          }}
        >
          {/* ── Glass background ── */}
          <div
            className="absolute inset-0"
            style={{
              borderRadius: scrolled ? 9999 : 0,
              opacity: showSolidBg ? 1 : 0,
              background: "hsla(240 20% 99% / 0.78)",
              backdropFilter: "blur(32px) saturate(1.8)",
              WebkitBackdropFilter: "blur(32px) saturate(1.8)",
              border: "1px solid hsla(0 0% 100% / 0.35)",
              transition: "all 0.45s cubic-bezier(0.25, 1, 0.5, 1)",
            }}
          />

          {/* ── Bottom border when expanded ── */}
          <div
            className="absolute bottom-0 left-0 right-0 h-px"
            style={{
              background: "linear-gradient(90deg, transparent, hsla(230 25% 14% / 0.06), transparent)",
              opacity: showSolidBg ? 0 : 1,
              transition: "opacity 0.3s ease",
            }}
          />

          {/* ── Content layer ── */}
          <div className="relative z-10 flex items-center w-full">
            {/* ── Left: Logo ── */}
            {!scrolled && (
              <div
                className="hidden md:flex items-center gap-2.5 flex-shrink-0 overflow-hidden"
                style={{
                  maxWidth: 600,
                  opacity: 1,
                  marginRight: 16,
                  transition: "all 0.45s cubic-bezier(0.25, 1, 0.5, 1)",
                }}
              >
                <Link href="/home" className="flex items-center gap-2.5" style={{ textDecoration: "none" }}>
                  <div className="w-8 h-8 rounded-xl bg-foreground flex items-center justify-center flex-shrink-0">
                    <Home className="w-4 h-4 text-background" />
                  </div>
                  <span className="hidden font-display text-sm font-bold tracking-normal text-foreground whitespace-nowrap xl:inline">
                    基于智慧家居场景的大语言模型智能体科研应用一体机
                  </span>
                </Link>
              </div>
            )}

            {/* ── Center: Route links ── */}
            <div
              ref={containerRef}
              className={`hidden md:flex items-center gap-0.5 ${scrolled ? "" : "absolute left-1/2 -translate-x-1/2"}`}
              onMouseLeave={onMouseLeave}
            >
              {/* Sliding hover indicator */}
              <div
                ref={indicatorRef}
                className="absolute top-0 left-0 rounded-full pointer-events-none"
                style={{
                  background: "hsla(230 25% 14% / 0.07)",
                  opacity: 0,
                  transition:
                    "transform 0.28s cubic-bezier(0.16, 1, 0.3, 1), width 0.28s cubic-bezier(0.16, 1, 0.3, 1), height 0.28s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.18s ease",
                }}
              />

              {NAV_ITEMS.map((item, i) => {
                const isActive = item.type === "route"
                  ? pathname === item.href
                  : isHomePage && currentHash === item.href;
                const isHovered = hovIdx === i;
                const targetHref = item.type === "section" ? (isHomePage ? item.href : `/home${item.href}`) : item.href;
                return (
                  <div
                    key={`${item.type}-${item.href}`}
                    ref={(el) => {
                      itemRefs.current[i] = el;
                    }}
                    onMouseEnter={() => onMouseEnter(i)}
                    className="relative"
                  >
                    <Link
                      href={targetHref}
                      onClick={item.type === "section" ? handleSectionNavigation(item.href) : undefined}
                      className="block px-3.5 py-1.5 text-sm rounded-full whitespace-nowrap"
                      style={{
                        textDecoration: "none",
                        fontWeight: isActive || isHovered ? 500 : 400,
                        color:
                          isActive || isHovered
                            ? "hsl(230 25% 14%)"
                            : "hsl(230 25% 14% / 0.55)",
                        transition: "color 0.2s ease, font-weight 0.2s ease",
                      }}
                    >
                      {item.label}
                    </Link>
                  </div>
                );
              })}
            </div>

            {/* ── Right: User area (login / avatar + workspace) ── */}
            {!scrolled && (
              <div
                className="hidden items-center gap-2 ml-auto flex-shrink-0 md:flex"
                style={{
                  maxWidth: 420,
                  opacity: 1,
                  transition: "all 0.45s cubic-bezier(0.25, 1, 0.5, 1)",
                }}
              >
                <button
                  onClick={handleWorkspaceNavigation}
                  disabled={authLoading}
                  aria-busy={authLoading}
                  title={authError && !user ? `身份校验失败：${authError}` : undefined}
                  className="inline-flex items-center gap-2"
                  style={{
                    padding: "8px 14px",
                    borderRadius: 24,
                    background: "hsl(230 25% 14%)",
                    color: "#fff",
                    fontSize: 12,
                    fontWeight: 500,
                    border: "none",
                    cursor: authLoading ? "wait" : "pointer",
                    opacity: authLoading ? 0.7 : 1,
                    transition: "transform 0.3s cubic-bezier(0.34,1.56,0.64,1), opacity 0.15s",
                    fontFamily: "inherit",
                    lineHeight: 1.2,
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.04)")}
                  onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
                >
                  <LayoutDashboard size={14} strokeWidth={2} />
                  <span>{authLoading ? "正在确认身份" : "访问控制台"}</span>
                </button>

                {/* User state */}
                {user && (
                  /* ── Logged in: avatar + dropdown ── */
                  <div style={{ position: "relative" }}>
                    <button
                      type="button"
                      onClick={() => setShowMenu(!showMenu)}
                      aria-label={`${user.username || "当前用户"}的账号菜单`}
                      aria-haspopup="menu"
                      aria-expanded={showMenu}
                      aria-controls="home-account-menu"
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: "50%",
                        background: "var(--glass-cobalt-tint, hsl(220 70% 50%))",
                        boxShadow: "var(--shadow-cobalt, 0 2px 8px rgba(0,82,209,0.25))",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#fff",
                        fontSize: 13,
                        fontWeight: 600,
                        border: "none",
                        cursor: "pointer",
                        transition: "transform 0.15s ease",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.08)")}
                      onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
                    >
                      {user.username?.charAt(0).toUpperCase() || "U"}
                    </button>

                    {/* Dropdown menu */}
                    {showMenu && (
                      <>
                        {/* Invisible backdrop to close menu */}
                        <div
                          style={{ position: "fixed", inset: 0, zIndex: 299 }}
                          onClick={() => setShowMenu(false)}
                        />
                        <div
                          id="home-account-menu"
                          role="menu"
                          aria-label="账号菜单"
                          style={{
                            position: "absolute",
                            top: "calc(100% + 8px)",
                            right: 0,
                            width: 180,
                            background: "hsl(var(--card, 0 0% 100%))",
                            border: "1px solid hsl(var(--border, 0 0% 90%) / 0.6)",
                            borderRadius: 14,
                            boxShadow: "0 8px 30px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04)",
                            padding: "6px",
                            zIndex: 300,
                            animation: "dialogSlideUp 0.15s cubic-bezier(0.25,0.8,0.25,1) both",
                          }}
                        >
                          <div
                            style={{
                              padding: "10px 12px 8px",
                              borderBottom: "1px solid hsl(var(--border, 0 0% 90%) / 0.4)",
                              marginBottom: 4,
                            }}
                          >
                            <div style={{ fontSize: 13, fontWeight: 500, color: "hsl(230 25% 14%)" }}>
                              {user.username || "未登录"}
                            </div>
                            <div style={{ fontSize: 11, color: "hsl(230 25% 14% / 0.5)", marginTop: 2 }}>
                              {user.role === "admin" ? "管理员" : "普通用户"}
                            </div>
                          </div>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={logout}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              width: "100%",
                              padding: "8px 12px",
                              borderRadius: 8,
                              background: "transparent",
                              border: "none",
                              fontSize: 13,
                              color: "hsl(0 70% 45%)",
                              cursor: "pointer",
                              fontFamily: "inherit",
                              transition: "background 0.12s ease",
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = "hsl(0 80% 96%)")}
                            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                          >
                            <LogOut size={14} strokeWidth={1.8} />
                            退出登录
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="flex w-full items-center justify-between gap-3 md:hidden">
              <Link href="/home" className="flex items-center gap-2 text-foreground" aria-label="返回首页">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-foreground text-background">
                  <Home size={16} />
                </span>
                {!scrolled ? <span className="text-sm font-semibold">智慧空间智能体</span> : null}
              </Link>
              <button
                type="button"
                onClick={() => setShowMobileMenu((open) => !open)}
                className="flex h-9 w-9 items-center justify-center rounded-full text-foreground transition-colors hover:bg-foreground/5"
                aria-label={showMobileMenu ? "关闭导航菜单" : "打开导航菜单"}
                aria-expanded={showMobileMenu}
              >
                {showMobileMenu ? <X size={18} /> : <Menu size={18} />}
              </button>
            </div>
          </div>
        </div>

        {showMobileMenu ? (
          <div className="pointer-events-auto fixed left-4 right-4 top-16 overflow-hidden rounded-2xl border border-border/70 bg-background/95 p-2 shadow-xl backdrop-blur-xl md:hidden">
            {NAV_ITEMS.map((item) => {
              const targetHref = item.type === "section" ? (isHomePage ? item.href : `/home${item.href}`) : item.href;
              return (
                <Link
                  key={`${item.type}-${item.href}-mobile`}
                  href={targetHref}
                  onClick={(event) => {
                    if (item.type === "section") handleSectionNavigation(item.href)(event);
                    setShowMobileMenu(false);
                  }}
                  className="block rounded-xl px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                >
                  {item.label}
                </Link>
              );
            })}
            <button
              type="button"
              onClick={(event) => {
                setShowMobileMenu(false);
                handleWorkspaceNavigation(event);
              }}
              className="mt-1 flex w-full items-center justify-between rounded-xl bg-foreground px-4 py-3 text-sm font-medium text-background"
              disabled={authLoading}
              aria-busy={authLoading}
            >
              {authLoading ? "正在确认身份" : "访问控制台"} <LayoutDashboard size={16} />
            </button>
          </div>
        ) : null}
      </nav>
    </>
  );
};

export default Navbar;
