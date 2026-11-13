"use client";

import { useRef, useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import { Button } from "@/components/ui/aura-button";
import { ArrowRight, MessageSquare, LayoutGrid, FlaskConical, BookOpen } from "lucide-react";
import UnicornBackground from "@/components/home/UnicornBackground";

const tabs = [
  { label: "AI 控制", icon: MessageSquare, prompt: "把客厅灯光调暗一点", preview: "示例意图：设备控制" },
  { label: "仪表盘", icon: LayoutGrid, prompt: "查看当前服务和设备状态", preview: "示例视图：运行摘要" },
  { label: "沙盒实验", icon: FlaskConical, prompt: "在沙盘中验证回家场景", preview: "示例模式：不控制实机" },
  { label: "知识库", icon: BookOpen, prompt: "检索设备接入与故障说明", preview: "示例流程：知识检索" },
];

const HeroSection = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState(0);
  const [manualSelection, setManualSelection] = useState(false);
  const reduceMotion = useReducedMotion();

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start start", "end start"],
  });

  const heroY = useTransform(scrollYProgress, [0, 1], [0, -120]);
  const deviceY = useTransform(scrollYProgress, [0, 1], [0, -60]);
  const heroOpacity = useTransform(scrollYProgress, [0, 0.4], [1, 0]);
  const heroScale = useTransform(scrollYProgress, [0, 0.5], [1, 0.95]);

  useEffect(() => {
    if (manualSelection || reduceMotion) return;
    let interval: ReturnType<typeof setInterval> | null = null;
    const syncRotation = () => {
      if (interval) clearInterval(interval);
      interval = null;
      if (document.visibilityState !== "visible") return;
      interval = setInterval(() => {
        setActiveTab((prev) => (prev + 1) % tabs.length);
      }, 3500);
    };
    syncRotation();
    document.addEventListener("visibilitychange", syncRotation);
    return () => {
      if (interval) clearInterval(interval);
      document.removeEventListener("visibilitychange", syncRotation);
    };
  }, [manualSelection, reduceMotion]);

  return (
    <section
      ref={containerRef}
      className="relative flex min-h-[calc(100svh-48px)] items-center overflow-hidden"
    >
      {/* UnicornStudio WebGL 背景 */}
      <UnicornBackground />


      <motion.div
        className="max-w-7xl mx-auto w-full section-padding relative z-10"
        style={{ y: heroY, opacity: heroOpacity, scale: heroScale }}
      >
        <div className="grid items-center gap-6 pb-10 pt-20 lg:grid-cols-12 lg:gap-8 lg:py-16">
          {/* Left — 7 cols */}
          <div className="space-y-6 lg:col-span-7 lg:space-y-10">
            <motion.div
              initial={{ opacity: 0, y: 30, filter: "blur(8px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
              className="inline-flex items-center gap-2.5 px-4 py-2 rounded-full border border-border/60 bg-background/60 backdrop-blur-sm"
            >
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-sm text-muted-foreground">科研级 AI 智能家居平台</span>
            </motion.div>

            <div className="space-y-6">
              <motion.h1
                initial={{ opacity: 0, y: 40, filter: "blur(10px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                transition={{ duration: 1.1, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
                className="text-[2.25rem] md:text-[3.4rem] lg:text-[4rem] leading-[1.05] tracking-normal text-foreground"
                style={{
                  fontFamily: "'Oswald', 'PingFang SC', 'Noto Sans SC', sans-serif",
                  fontWeight: 700,
                  WebkitTextStroke: "1.5px currentColor",
                }}
              >
                大语言模型驱动的
                <br />
                <span
                  className="inline-block mt-2 text-primary"
                  style={{
                    fontWeight: 700,
                    WebkitTextStroke: "1.5px currentColor",
                  }}
                >
                  智慧空间智能体平台
                </span>
              </motion.h1>

              <motion.p
                initial={{ opacity: 0, y: 30, filter: "blur(6px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                transition={{ duration: 1, delay: 0.35, ease: [0.16, 1, 0.3, 1] }}
                className="max-w-lg text-base font-light leading-relaxed tracking-normal text-muted-foreground md:text-xl"
              >
                基于智慧家居场景，融合本地大模型推理与 AI 智能体，
                打造面向科研的全链路智能应用平台。
              </motion.p>
            </div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.55, ease: [0.16, 1, 0.3, 1] }}
              className="flex flex-wrap items-center gap-3 md:gap-4"
            >
              <Button variant="hero" size="xl" asChild className="h-12 px-6 text-sm md:h-14 md:px-10 md:text-base">
                <Link href="/chat">开始体验 <ArrowRight className="w-4 h-4 ml-1" /></Link>
              </Button>
              <Button variant="hero-outline" size="xl" asChild className="h-12 px-6 text-sm md:h-14 md:px-10 md:text-base">
                <a href="#capabilities">探索核心能力</a>
              </Button>
            </motion.div>


          </div>

          {/* Right — 5 cols: Device */}
          <motion.div
            className="relative flex justify-center lg:col-span-5"
            style={{ y: deviceY }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 40 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: 1.2, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
              className="relative w-full max-w-[230px] md:max-w-[340px] lg:max-w-none"
            >
              <div className="absolute -inset-12 rounded-[3rem] bg-primary/[0.06] blur-3xl" />
              <Image
                src="/images/hero-device.png"
                alt="智慧空间智能体控制面板"
                width={1024}
                height={1024}
                priority
                sizes="(max-width: 1024px) 80vw, 420px"
                className="relative w-full max-w-[420px] rounded-3xl"
              />

              {/* Floating command bubble */}
              <motion.div
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.8, delay: 1.0 }}
                className="absolute -left-10 top-1/4 max-w-[155px] rounded-2xl px-3 py-2 shadow-lg glass-panel breathe-offset md:max-w-[200px] md:px-4 md:py-3"
              >
                <p className="text-xs text-muted-foreground mb-1">你说：</p>
                <p className="text-sm font-medium text-foreground leading-snug">
                  &ldquo;{tabs[activeTab].prompt}&rdquo;
                </p>
              </motion.div>

              {/* Status indicator */}
              <motion.div
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.8, delay: 1.2 }}
                className="absolute -right-10 bottom-1/3 rounded-2xl px-3 py-2 shadow-lg glass-panel breathe md:-right-4 md:px-4 md:py-3"
              >
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-blue-500" />
                  <span className="text-xs font-medium text-foreground md:text-sm">{tabs[activeTab].preview}</span>
                </div>
              </motion.div>

              {/* Tab switcher */}
              <div className="absolute -bottom-5 left-1/2 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 gap-1 overflow-x-auto rounded-2xl p-1 shadow-lg glass-panel-strong md:-bottom-6 md:p-1.5">
                {tabs.map((tab, i) => {
                  const Icon = tab.icon;
                  return (
                    <button
                      key={tab.label}
                      onClick={() => {
                        setManualSelection(true);
                        setActiveTab(i);
                      }}
                      aria-pressed={activeTab === i}
                      className={`flex items-center gap-1 px-2.5 py-2 rounded-xl text-[11px] font-medium whitespace-nowrap transition-all duration-500 btn-spring md:gap-1.5 md:px-4 md:text-xs ${
                        activeTab === i
                          ? "bg-foreground text-background shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      {tab.label}
                    </button>
                  );
                })}
              </div>
            </motion.div>
          </motion.div>
        </div>
      </motion.div>

      {/* Scroll indicator */}
      <motion.div
        className="absolute bottom-2 left-1/2 hidden -translate-x-1/2 flex-col items-center gap-2 lg:flex"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.5, duration: 1 }}
      >
        <span className="text-xs text-muted-foreground tracking-widest uppercase">向下滚动</span>
        <motion.div
          className="w-5 h-8 rounded-full border-2 border-muted-foreground/30 flex items-start justify-center p-1"
          animate={reduceMotion ? undefined : { opacity: [0.4, 1, 0.4] }}
          transition={reduceMotion ? undefined : { duration: 2, repeat: Infinity }}
        >
          <motion.div
            className="w-1 h-1.5 rounded-full bg-muted-foreground/50"
            animate={reduceMotion ? undefined : { y: [0, 12, 0] }}
            transition={reduceMotion ? undefined : { duration: 2, repeat: Infinity, ease: "easeInOut" }}
          />
        </motion.div>
      </motion.div>
    </section>
  );
};

export default HeroSection;
