"use client";

import { useRef } from "react";
import { motion, useReducedMotion, useScroll, useTransform, useInView } from "motion/react";
import { Sun, Moon, Thermometer, Music } from "lucide-react";
import TiltCard from "@/components/home/TiltCard";

const scenarios = [
  {
    icon: Sun,
    command: "早安 — 打开窗帘，启动咖啡机",
    context: "晨间日常",
    response: "可编排窗帘与咖啡机动作；执行前核对实体映射，执行后分别记录回读状态。",
    gradient: "from-amber-400/10 via-orange-300/5 to-transparent",
    iconColor: "text-amber-500",
    dotColor: "bg-amber-400",
  },
  {
    icon: Moon,
    command: "电影之夜 — 把灯光调暗，设置暖色氛围",
    context: "娱乐场景",
    response: "可将亮度与色温拆分为设备服务调用；乐观回写设备继续提示现场确认。",
    gradient: "from-blue-400/10 via-indigo-300/5 to-transparent",
    iconColor: "text-blue-500",
    dotColor: "bg-blue-400",
  },
  {
    icon: Thermometer,
    command: "有点热了 — 给书房降降温",
    context: "气候控制",
    response: "可识别房间、目标温度和联动设备，并在下发前展示将要执行的动作。",
    gradient: "from-emerald-400/10 via-teal-300/5 to-transparent",
    iconColor: "text-emerald-500",
    dotColor: "bg-emerald-400",
  },
  {
    icon: Music,
    command: "做饭时在厨房放点轻松的音乐",
    context: "氛围音乐",
    response: "媒体播放能力取决于已接入的音箱实体、媒体源和 Home Assistant 服务权限。",
    gradient: "from-rose-400/10 via-pink-300/5 to-transparent",
    iconColor: "text-rose-500",
    dotColor: "bg-rose-400",
  },
];

const ScenariosSection = () => {
  const sectionRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const isHeadingInView = useInView(headingRef, { once: true, amount: 0.5 });

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start end", "end start"],
  });

  const orbY = useTransform(scrollYProgress, [0, 1], [100, -100]);

  return (
    <section
      id="scenarios"
      ref={sectionRef}
      className="relative py-40 overflow-hidden"
    >
      <motion.div className="absolute inset-0 pointer-events-none" style={{ y: orbY }}>
        <div className="ambient-orb w-[500px] h-[500px] right-[-150px] top-[20%] bg-primary/[0.04]" />
        <div className="ambient-orb w-[350px] h-[350px] left-[5%] bottom-[15%] bg-[hsla(35,80%,65%,0.03)]" />
      </motion.div>

      <div className="max-w-7xl mx-auto section-padding relative">
        <div ref={headingRef} className="max-w-3xl mx-auto text-center mb-24">
          <motion.div
            initial={{ opacity: 0, scaleX: 0 }}
            animate={isHeadingInView ? { opacity: 1, scaleX: 1 } : {}}
            transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
            className="h-[2px] w-12 bg-primary/40 mb-6 rounded-full mx-auto origin-center"
          />
          <motion.p
            initial={{ opacity: 0 }}
            animate={isHeadingInView ? { opacity: 1 } : {}}
            transition={{ duration: 0.8, delay: 0.1 }}
            className="text-sm font-medium text-primary mb-5 tracking-wide uppercase"
          >
            应用场景
          </motion.p>
          <motion.h2
            initial={{ opacity: 0, y: 40, filter: "blur(10px)" }}
            animate={isHeadingInView ? { opacity: 1, y: 0, filter: "blur(0px)" } : {}}
            transition={{ duration: 1.1, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="font-display text-4xl md:text-[3.5rem] lg:text-[4rem] font-bold tracking-normal text-foreground leading-[1.0] mb-6"
          >
            与你的环境对话
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={isHeadingInView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.9, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="text-xl text-muted-foreground leading-relaxed max-w-md mx-auto font-light"
          >
            以下内容是交互示例，不代表现场设备已经执行。
          </motion.p>
        </div>

        <div className="grid lg:grid-cols-2 gap-8">
          {scenarios.map((s, i) => (
            <ScenarioCard key={s.context} scenario={s} index={i} />
          ))}
        </div>
      </div>
    </section>
  );
};

const ScenarioCard = ({
  scenario,
  index,
}: {
  scenario: (typeof scenarios)[0];
  index: number;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const reduceMotion = useReducedMotion();
  const Icon = scenario.icon;

  const isRight = index % 2 !== 0;

  return (
    <motion.div
      ref={ref}
      initial={{
        opacity: 0,
        x: isRight ? 60 : -60,
        y: 20,
        filter: "blur(8px)",
      }}
      animate={isInView ? { opacity: 1, x: 0, y: 0, filter: "blur(0px)" } : {}}
      transition={{
        duration: 1,
        delay: index * 0.12,
        ease: [0.16, 1, 0.3, 1],
      }}
      className={isRight ? "lg:mt-20" : ""}
    >
      <TiltCard className="surface-elevated rounded-3xl light-sheen overflow-hidden" intensity={5}>
        <div className={`h-24 bg-gradient-to-br ${scenario.gradient} relative`}>
          <div className="absolute inset-0 flex items-center justify-center">
            <motion.div
              animate={reduceMotion ? undefined : { scale: [1, 1.05, 1], opacity: [0.6, 1, 0.6] }}
              transition={reduceMotion ? undefined : { duration: 3, repeat: Infinity, ease: "easeInOut" }}
              className="w-14 h-14 rounded-2xl bg-background/80 backdrop-blur-sm flex items-center justify-center shadow-sm"
            >
              <Icon className={`w-6 h-6 ${scenario.iconColor}`} />
            </motion.div>
          </div>
        </div>

        <div className="p-8 pt-6">
          <span className="text-[11px] font-medium text-muted-foreground tracking-widest uppercase">
            {scenario.context}
          </span>

          <div className="relative my-5">
            <div className="absolute left-0 top-0 bottom-0 w-[2px] rounded-full bg-primary/20" />
            <p className="pl-5 text-lg font-medium text-foreground leading-snug tracking-normal">
              &ldquo;{scenario.command}&rdquo;
            </p>
          </div>

          <div className="flex items-start gap-3 mt-4">
            <motion.div
              animate={reduceMotion ? undefined : { scale: [1, 1.3, 1] }}
              transition={reduceMotion ? undefined : { duration: 2, repeat: Infinity, ease: "easeInOut" }}
              className={`w-2 h-2 rounded-full ${scenario.dotColor} mt-1.5 shrink-0`}
            />
            <div>
              <p className="text-[11px] font-medium text-muted-foreground">预期处理方式</p>
              <p className="mt-1 text-sm text-muted-foreground leading-relaxed">{scenario.response}</p>
            </div>
          </div>
        </div>
      </TiltCard>
    </motion.div>
  );
};

export default ScenariosSection;
