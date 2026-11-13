"use client";

import { useRef } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";

const DynamicLighting = () => {
  const ref = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const { scrollYProgress } = useScroll();

  const warmOpacity = useTransform(scrollYProgress, [0, 0.3, 0.6], [0.3, 0.2, 0]);
  const coolOpacity = useTransform(scrollYProgress, [0.2, 0.5, 0.8], [0, 0.5, 1]);
  const mixedOpacity = useTransform(scrollYProgress, [0.3, 0.5, 0.7], [0, 1, 0]);

  return (
    <div ref={ref} className={`fixed inset-0 pointer-events-none z-0 ${reduceMotion ? "hidden" : ""}`} aria-hidden="true">
      <motion.div className="absolute inset-0" style={{ opacity: warmOpacity }}>
        <div className="absolute w-[700px] h-[700px] top-[-10%] left-[-5%] rounded-full bg-[hsla(35,80%,65%,0.07)] blur-[120px]" />
        <div className="absolute w-[400px] h-[400px] top-[20%] right-[10%] rounded-full bg-[hsla(25,70%,60%,0.05)] blur-[100px]" />
      </motion.div>
      <motion.div className="absolute inset-0" style={{ opacity: mixedOpacity }}>
        <div className="absolute w-[500px] h-[500px] top-[40%] left-[20%] rounded-full bg-[hsla(35,60%,60%,0.04)] blur-[100px]" />
        <div className="absolute w-[500px] h-[500px] top-[35%] right-[15%] rounded-full bg-[hsla(245,58%,51%,0.04)] blur-[100px]" />
      </motion.div>
      <motion.div className="absolute inset-0" style={{ opacity: coolOpacity }}>
        <div className="absolute w-[600px] h-[600px] bottom-[10%] right-[-5%] rounded-full bg-[hsla(245,58%,51%,0.06)] blur-[120px]" />
        <div className="absolute w-[400px] h-[400px] bottom-[30%] left-[10%] rounded-full bg-[hsla(255,50%,60%,0.04)] blur-[100px]" />
      </motion.div>
    </div>
  );
};

export default DynamicLighting;
