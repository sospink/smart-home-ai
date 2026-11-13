"use client";

import { useRef } from "react";
import Link from "next/link";
import { motion, useInView, useReducedMotion, useScroll, useTransform } from "motion/react";
import { Button } from "@/components/ui/aura-button";
import { ArrowRight, BookOpen } from "lucide-react";

const CTASection = () => {
  const sectionRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const reduceMotion = useReducedMotion();

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start end", "end start"],
  });

  const scale = useTransform(scrollYProgress, [0, 0.5], [0.92, 1]);
  const y = useTransform(scrollYProgress, [0, 0.5], [40, 0]);

  return (
    <section id="cta" className="py-32 relative" ref={sectionRef}>
      <div className="max-w-7xl mx-auto section-padding" ref={ref}>
        <motion.div
          style={{ scale, y }}
          className="relative rounded-[2.5rem] overflow-hidden"
        >
          <div className="absolute inset-0 bg-foreground" />

          <div className="absolute inset-0 overflow-hidden">
            <motion.div
              animate={reduceMotion ? undefined : {
                x: [0, 40, -20, 0],
                y: [0, -30, 20, 0],
                scale: [1, 1.2, 0.9, 1],
              }}
              transition={reduceMotion ? undefined : { duration: 20, repeat: Infinity, ease: "linear" }}
              className="absolute -top-32 -right-32 w-[500px] h-[500px] rounded-full bg-primary/25 blur-[140px]"
            />
            <motion.div
              animate={reduceMotion ? undefined : {
                x: [0, -30, 40, 0],
                y: [0, 40, -20, 0],
                scale: [1, 0.9, 1.1, 1],
              }}
              transition={reduceMotion ? undefined : { duration: 25, repeat: Infinity, ease: "linear" }}
              className="absolute -bottom-40 -left-32 w-[450px] h-[450px] rounded-full bg-primary/15 blur-[120px]"
            />
            <motion.div
              animate={reduceMotion ? undefined : {
                x: [0, 20, -30, 0],
                y: [0, -20, 10, 0],
              }}
              transition={reduceMotion ? undefined : { duration: 18, repeat: Infinity, ease: "linear" }}
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[300px] h-[300px] rounded-full bg-[hsla(35,60%,60%,0.08)] blur-[100px]"
            />
          </div>

          <div className="relative px-8 md:px-20 py-28 md:py-32">
            <div className="max-w-2xl mx-auto text-center">
              <motion.div
                initial={{ opacity: 0, scaleX: 0 }}
                animate={isInView ? { opacity: 1, scaleX: 1 } : {}}
                transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
                className="h-[2px] w-12 bg-background/20 mb-8 rounded-full mx-auto"
              />
              <motion.h2
                initial={{ opacity: 0, y: 30, filter: "blur(10px)" }}
                animate={isInView ? { opacity: 1, y: 0, filter: "blur(0px)" } : {}}
                transition={{ duration: 1, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
                className="font-display text-3xl md:text-[3.5rem] font-bold tracking-normal text-background leading-[1.0] mb-7"
              >
                准备好重新定义
                <br />
                空间智能了吗？
              </motion.h2>
              <motion.p
                initial={{ opacity: 0, y: 20 }}
                animate={isInView ? { opacity: 1, y: 0 } : {}}
                transition={{ duration: 0.9, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="text-lg text-background/45 max-w-md mx-auto mb-12 leading-relaxed font-light"
              >
                一个面向科研人员、工程师以及所有相信 AI 应该理解物理世界的人的平台。
              </motion.p>
              <motion.div
                initial={{ opacity: 0, y: 15 }}
                animate={isInView ? { opacity: 1, y: 0 } : {}}
                transition={{ duration: 0.8, delay: 0.45, ease: [0.16, 1, 0.3, 1] }}
                className="flex flex-wrap justify-center gap-4"
              >
                <Button
                  size="xl"
                  asChild
                  className="bg-background text-foreground hover:bg-background/90 rounded-full shadow-lg shadow-background/10 btn-spring"
                >
                  <Link href="/chat">进入智能体工作台 <ArrowRight className="w-4 h-4 ml-1" /></Link>
                </Button>
                <Button
                  size="xl"
                  variant="ghost"
                  asChild
                  className="text-background/50 hover:text-background hover:bg-background/10 rounded-full btn-spring"
                >
                  <Link href="/docs"><BookOpen className="w-4 h-4 mr-1" /> 阅读帮助文档</Link>
                </Button>
              </motion.div>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
};

export default CTASection;
