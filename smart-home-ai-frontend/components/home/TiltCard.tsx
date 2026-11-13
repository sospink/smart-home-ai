"use client";

import { useRef, useCallback, type ReactNode } from "react";
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from "motion/react";

interface TiltCardProps {
  children: ReactNode;
  className?: string;
  intensity?: number;
}

const TiltCard = ({ children, className = "", intensity = 8 }: TiltCardProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const mouseX = useMotionValue(0.5);
  const mouseY = useMotionValue(0.5);

  const rotateX = useSpring(useTransform(mouseY, [0, 1], [intensity, -intensity]), {
    stiffness: 150,
    damping: 20,
  });
  const rotateY = useSpring(useTransform(mouseX, [0, 1], [-intensity, intensity]), {
    stiffness: 150,
    damping: 20,
  });

  const lightX = useSpring(useTransform(mouseX, [0, 1], [0, 100]), { stiffness: 150, damping: 20 });
  const lightY = useSpring(useTransform(mouseY, [0, 1], [0, 100]), { stiffness: 150, damping: 20 });
  const lightBackground = useTransform(
    [lightX, lightY],
    ([x, y]) =>
      `radial-gradient(circle at ${x}% ${y}%, hsla(0 0% 100% / 0.12) 0%, transparent 60%)`
  );

  const handleMouse = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      mouseX.set((e.clientX - rect.left) / rect.width);
      mouseY.set((e.clientY - rect.top) / rect.height);
    },
    [mouseX, mouseY]
  );

  const handleLeave = useCallback(() => {
    mouseX.set(0.5);
    mouseY.set(0.5);
  }, [mouseX, mouseY]);

  return (
    <div className="card-3d" style={{ perspective: 800 }}>
      <motion.div
        ref={ref}
        onMouseMove={reduceMotion ? undefined : handleMouse}
        onMouseLeave={handleLeave}
        style={reduceMotion ? undefined : { rotateX, rotateY, transformStyle: "preserve-3d" }}
        className={`relative ${className}`}
      >
        <motion.div
          className="absolute inset-0 rounded-[inherit] pointer-events-none z-10"
          style={{ background: lightBackground }}
        />
        {children}
      </motion.div>
    </div>
  );
};

export default TiltCard;
