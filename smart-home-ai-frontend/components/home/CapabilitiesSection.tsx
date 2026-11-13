"use client";

import { useRef } from "react";
import Image from "next/image";
import { motion, useScroll, useTransform, useInView } from "motion/react";
import { MessageSquare, Monitor, Zap, Database } from "lucide-react";

const CapabilitiesSection = () => {
  const sectionRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const isHeadingInView = useInView(headingRef, { once: true, amount: 0.5 });

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start end", "end start"],
  });

  const bgY = useTransform(scrollYProgress, [0, 1], [80, -80]);

  return (
    <section
      id="capabilities"
      ref={sectionRef}
      className="relative py-40 overflow-hidden"
    >
      <motion.div className="absolute inset-0 pointer-events-none" style={{ y: bgY }}>
        <div className="ambient-orb w-[600px] h-[600px] -left-[200px] top-[10%] bg-[hsla(35,80%,65%,0.04)]" />
        <div className="ambient-orb w-[400px] h-[400px] right-[-100px] bottom-[20%] bg-primary/[0.03]" />
      </motion.div>

      <div className="max-w-7xl mx-auto section-padding relative">
        {/* ── Heading ── */}
        <div ref={headingRef} className="flex flex-col md:flex-row items-end justify-between mb-24 gap-8">
          <div className="max-w-2xl">
            <motion.div
              initial={{ opacity: 0, width: 0 }}
              animate={isHeadingInView ? { opacity: 1, width: 48 } : {}}
              transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
              className="h-[2px] bg-primary/40 mb-6 rounded-full"
            />
            <motion.p
              initial={{ opacity: 0, x: -20 }}
              animate={isHeadingInView ? { opacity: 1, x: 0 } : {}}
              transition={{ duration: 0.8, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
              className="text-sm font-medium text-primary mb-5 tracking-wide uppercase"
            >
              平台能力
            </motion.p>
            <motion.h2
              initial={{ opacity: 0, y: 40, filter: "blur(10px)" }}
              animate={isHeadingInView ? { opacity: 1, y: 0, filter: "blur(0px)" } : {}}
              transition={{ duration: 1.1, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
              className="font-display text-4xl md:text-[3.5rem] lg:text-[4rem] font-bold tracking-normal text-foreground leading-[1.0]"
            >
              核心功能
            </motion.h2>
          </div>
          <motion.p
            initial={{ opacity: 0, y: 25 }}
            animate={isHeadingInView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.9, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="text-muted-foreground max-w-sm leading-relaxed text-sm font-light"
          >
            LLM 推理 · 智能体框架 · 智慧家居 · 知识增强 · 应用模板 · Web 管理，一个平台全覆盖。
          </motion.p>
        </div>

        {/* ── Bento Grid ── */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
          {/* AI 智能对话 — 大卡 */}
          <BentoCard index={0} className="md:col-span-8">
            <div className="group relative bg-card rounded-3xl p-10 overflow-hidden hover:shadow-2xl transition-all duration-700 h-full border border-border/50">
              <div className="relative z-10 h-full flex flex-col justify-between">
                <div>
                  <MessageSquare className="w-10 h-10 text-primary mb-6" />
                  <h3 className="text-2xl font-display font-semibold mb-4 text-foreground">AI 智能对话</h3>
                  <p className="text-muted-foreground text-sm max-w-sm leading-relaxed">
                    基于 Dify 智能体工作流组织多轮对话、知识检索与设备意图。设备命令经平台校验后下发，并保留状态回读和实机确认边界。
                  </p>
                </div>
                <div className="mt-12 flex flex-wrap gap-3">
                  <span className="px-4 py-2 rounded-full bg-primary/10 text-primary text-[0.7rem] font-bold">Ollama</span>
                  <span className="px-4 py-2 rounded-full bg-primary/10 text-primary text-[0.7rem] font-bold">SSE 流式</span>
                  <span className="px-4 py-2 rounded-full bg-primary/10 text-primary text-[0.7rem] font-bold">本地推理</span>
                </div>
              </div>
              <div className="absolute right-0 top-0 w-[40%] h-full opacity-25 group-hover:opacity-40 transition-opacity duration-700">
                <Image
                  alt="智能体对话界面示意"
                  className="w-full h-full object-cover"
                  src="/images/img1.png"
                  fill
                  sizes="(max-width: 768px) 40vw, 320px"
                />
              </div>
            </div>
          </BentoCard>

          {/* 电子沙盘 — 蓝色卡 */}
          <BentoCard index={1} className="md:col-span-4">
            <div className="bg-primary text-primary-foreground rounded-3xl p-10 flex flex-col justify-between hover:scale-[1.02] transition-transform duration-500 h-full">
              <Monitor className="w-10 h-10 mb-6" />
              <div>
                <h3 className="text-2xl font-display font-semibold mb-4">电子沙盘</h3>
                <p className="text-primary-foreground/70 text-sm">
                  通过 Home Assistant 虚拟实体验证部分控制和场景流程。涉及厂商云端、网关或物理反馈的实验仍需实机验收。
                </p>
              </div>
            </div>
          </BentoCard>

          {/* 设备控制 — 灰色卡 */}
          <BentoCard index={2} className="md:col-span-4">
            <div className="bg-muted rounded-3xl p-10 hover:shadow-inner transition-all duration-300 h-full">
              <Zap className="w-10 h-10 text-foreground mb-6" />
              <h3 className="text-xl font-display font-semibold mb-4 text-foreground">设备控制</h3>
              <p className="text-muted-foreground text-sm">
                接入 Home Assistant 实体状态与服务调用，支持设备台账、操作审计和控制后回读。Xiaomi 等乐观回写设备会明确提示待实机确认。
              </p>
            </div>
          </BentoCard>

          {/* 知识增强 RAG — 底部大卡 */}
          <BentoCard index={3} className="md:col-span-8">
            <div className="bg-card rounded-3xl p-10 flex flex-col md:flex-row gap-8 items-center border border-border/50 h-full">
              <div className="flex-1">
                <Database className="w-10 h-10 text-primary mb-6" />
                <h3 className="text-2xl font-display font-semibold mb-4 text-foreground">知识增强 RAG</h3>
                <p className="text-muted-foreground text-sm">
                  内置向量数据库与语义检索引擎，支持 PDF / Word / Markdown 等多格式文档导入。增量管理、混合检索，为 Agent 提供领域知识。
                </p>
              </div>
              <div className="w-48 h-32 bg-gradient-to-r from-orange-200 via-white to-indigo-200 rounded-md shadow-lg flex items-center justify-center flex-shrink-0">
                <span className="text-[0.6rem] font-bold text-foreground tracking-widest">混合检索</span>
              </div>
            </div>
          </BentoCard>
        </div>
      </div>
    </section>
  );
};

/* ── Animated wrapper for each bento card ── */
const BentoCard = ({
  children,
  index,
  className = "",
}: {
  children: React.ReactNode;
  index: number;
  className?: string;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.2 });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 50, filter: "blur(8px)" }}
      animate={isInView ? { opacity: 1, y: 0, filter: "blur(0px)" } : {}}
      transition={{
        duration: 0.9,
        delay: index * 0.12,
        ease: [0.16, 1, 0.3, 1],
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
};

export default CapabilitiesSection;
