"use client";

import { useRef } from "react";
import { motion, useScroll, useTransform, useInView } from "motion/react";
import { Server, Workflow, Lock, Globe } from "lucide-react";
import TiltCard from "@/components/home/TiltCard";

const layers = [
  { name: "应用层", desc: "UI、语音、API" },
  { name: "智能体编排", desc: "规划与执行" },
  { name: "大模型推理引擎", desc: "本地模型" },
  { name: "物联网协议桥接", desc: "MQTT、Zigbee、Matter" },
  { name: "硬件与传感器", desc: "物理设备" },
];

const pillars = [
  {
    icon: Server,
    title: "设备端大模型",
    desc: "可接入 Ollama 量化模型；是否可用以当前服务探测为准。",
  },
  {
    icon: Workflow,
    title: "智能体框架",
    desc: "模块化智能体，负责感知、规划和执行。",
  },
  {
    icon: Lock,
    title: "配置与权限边界",
    desc: "密钥仅由后端保存和使用，管理操作经过登录与角色校验。",
  },
  {
    icon: Globe,
    title: "开放协议层",
    desc: "通过 Home Assistant 承接多类设备协议，实际支持范围取决于现场集成与网关。",
  },
];

const TechnologySection = () => {
  const sectionRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const isHeadingInView = useInView(headingRef, { once: true, amount: 0.5 });
  const isStackInView = useInView(stackRef, { once: true, amount: 0.2 });

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start end", "end start"],
  });

  const orbY = useTransform(scrollYProgress, [0, 1], [60, -80]);

  return (
    <section
      id="technology"
      ref={sectionRef}
      className="relative py-40 overflow-hidden"
    >
      <motion.div className="absolute inset-0 pointer-events-none" style={{ y: orbY }}>
        <div className="ambient-orb w-[600px] h-[600px] left-[40%] top-[10%] bg-primary/[0.04]" />
      </motion.div>

      <div className="max-w-7xl mx-auto section-padding relative">
        <div ref={headingRef} className="max-w-3xl mb-24">
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
            技术架构
          </motion.p>
          <motion.h2
            initial={{ opacity: 0, y: 40, filter: "blur(10px)" }}
            animate={isHeadingInView ? { opacity: 1, y: 0, filter: "blur(0px)" } : {}}
            transition={{ duration: 1.1, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="font-display text-4xl md:text-[3.5rem] lg:text-[4rem] font-bold tracking-normal text-foreground leading-[1.0]"
          >
              面向科研验证，
            <br />
              <span className="text-gradient-primary">保留真实运行边界</span>
          </motion.h2>
        </div>

        <div className="grid lg:grid-cols-12 gap-12 items-start">
          <div ref={stackRef} className="lg:col-span-5 lg:sticky lg:top-32">
            <motion.div
              initial={{ opacity: 0, y: 40 }}
              animate={isStackInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
            >
              <TiltCard className="glass-panel rounded-3xl overflow-hidden" intensity={4}>
                <div className="p-7 relative">
                  <div className="absolute -top-16 -right-16 w-32 h-32 rounded-full bg-primary/[0.06] blur-[50px] pointer-events-none" />
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-widest mb-6 relative">
                    系统架构
                  </p>
                  <div className="space-y-2.5 relative">
                    {layers.map((layer, i) => (
                      <motion.div
                        key={layer.name}
                        initial={{ opacity: 0, x: -40, filter: "blur(4px)" }}
                        animate={isStackInView ? { opacity: 1, x: 0, filter: "blur(0px)" } : {}}
                        transition={{
                          duration: 0.8,
                          delay: 0.2 + i * 0.12,
                          ease: [0.16, 1, 0.3, 1],
                        }}
                        className="group relative"
                      >
                        <div className="flex items-center gap-4 px-5 py-3.5 rounded-2xl bg-background/60 border border-border/30 hover:border-primary/20 transition-all duration-500 hover:bg-background/80">
                          <motion.div
                            initial={{ scale: 0 }}
                            animate={isStackInView ? { scale: 1 } : {}}
                            transition={{
                              duration: 0.5,
                              delay: 0.4 + i * 0.12,
                              type: "spring",
                              stiffness: 300,
                              damping: 15,
                            }}
                            className="w-3 h-3 rounded-full shrink-0"
                            style={{
                              background: `hsl(${245 - i * 5} ${58 - i * 4}% ${51 + i * 7}%)`,
                              boxShadow: `0 0 8px hsla(${245 - i * 5} ${58 - i * 4}% ${51 + i * 7}% / 0.3)`,
                            }}
                          />
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-medium text-foreground">{layer.name}</span>
                          </div>
                          <span className="text-[11px] text-muted-foreground shrink-0">{layer.desc}</span>
                        </div>
                        {i < layers.length - 1 && (
                          <motion.div
                            initial={{ scaleY: 0 }}
                            animate={isStackInView ? { scaleY: 1 } : {}}
                            transition={{ duration: 0.4, delay: 0.5 + i * 0.12 }}
                            className="absolute left-[2.1rem] top-full w-px h-2.5 bg-primary/15 origin-top"
                          />
                        )}
                      </motion.div>
                    ))}
                  </div>
                </div>
              </TiltCard>
            </motion.div>
          </div>

          <div className="lg:col-span-7 space-y-6">
            {pillars.map((p, i) => (
              <PillarCard key={p.title} pillar={p} index={i} Icon={p.icon} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

const PillarCard = ({
  pillar,
  index,
  Icon,
}: {
  pillar: (typeof pillars)[0];
  index: number;
  Icon: typeof Server;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.4 });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, x: 50, filter: "blur(6px)" }}
      animate={isInView ? { opacity: 1, x: 0, filter: "blur(0px)" } : {}}
      transition={{
        duration: 0.9,
        delay: index * 0.12,
        ease: [0.16, 1, 0.3, 1],
      }}
    >
      <TiltCard className="surface-elevated rounded-3xl light-sheen" intensity={5}>
        <div className="p-7 flex items-start gap-6">
          <div className="w-12 h-12 rounded-2xl bg-primary/[0.06] flex items-center justify-center shrink-0 transition-colors duration-500">
            <Icon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 className="font-display font-semibold text-lg text-foreground mb-2 tracking-normal">
              {pillar.title}
            </h3>
            <p className="text-[0.9rem] text-muted-foreground leading-relaxed">
              {pillar.desc}
            </p>
          </div>
        </div>
      </TiltCard>
    </motion.div>
  );
};

export default TechnologySection;
