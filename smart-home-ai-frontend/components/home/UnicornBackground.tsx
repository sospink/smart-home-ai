"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";

/**
 * UnicornStudio WebGL 背景组件
 * 100% 复原 hero-bg-demo.html 的效果
 */
const UnicornBackground = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const reduceMotion = useReducedMotion();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (initialized.current || reduceMotion || window.matchMedia("(max-width: 767px)").matches) return;
    initialized.current = true;

    // 动态加载 UnicornStudio SDK
    const script = document.createElement("script");
    script.src =
      "https://cdn.jsdelivr.net/gh/hiunicornstudio/unicornstudio.js@v1.4.29/dist/unicornStudio.umd.js";
    script.async = true;
    script.onload = () => {
      // @ts-expect-error UnicornStudio is loaded from CDN
      if (window.UnicornStudio) {
        // @ts-expect-error UnicornStudio is loaded from CDN
        window.UnicornStudio.init();
        setReady(true);
      }
    };
    script.onerror = () => setReady(false);
    document.body.appendChild(script);

    return () => {
      // @ts-expect-error UnicornStudio is loaded from CDN
      if (window.UnicornStudio?.destroy) {
        // @ts-expect-error UnicornStudio is loaded from CDN
        window.UnicornStudio.destroy();
      }
      script.remove();
    };
  }, [reduceMotion]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-0 overflow-hidden"
      style={{
        maskImage: "linear-gradient(to bottom, black 60%, transparent 100%)",
        WebkitMaskImage: "linear-gradient(to bottom, black 60%, transparent 100%)",
      }}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_72%_28%,rgba(37,99,235,0.12),transparent_34%),radial-gradient(circle_at_20%_20%,rgba(245,158,11,0.10),transparent_32%)]" />
      {/* UnicornStudio 渲染容器 — 与 demo 完全一致的参数 */}
      <div
        data-us-project="ty3N7ZPaIU7KlWixQFIc"
        data-us-scale="1"
        data-us-dpi="1"
        data-us-fps="30"
        data-us-disablemobile="true"
        aria-hidden="true"
        className={`transition-opacity duration-700 ${ready && !reduceMotion ? "opacity-100" : "opacity-0"}`}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
        }}
      />
    </div>
  );
};

export default UnicornBackground;
