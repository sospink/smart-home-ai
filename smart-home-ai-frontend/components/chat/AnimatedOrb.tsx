'use client'

import React from 'react'

/**
 * AnimatedOrb — 动态色彩球
 * 5 层彩色圆形粒子在圆形容器内做轨道运动 + 色相旋转
 * 所有 CSS keyframes 已在 globals.css 中定义（orb-circle-1~5, orb-hue-rotate）
 */
export const AnimatedOrb: React.FC<{
    className?: string
    size?: number
}> = ({ className, size = 32 }) => {
    // 智能家居主题配色：蓝 + 橙 + 紫
    const colors = {
        bg: '#e0eaff',
        c1: '#0052d1',   // primary 蓝
        c2: '#156aff',   // primary-container
        c3: '#fe9400',   // secondary 橙
        c4: '#dae1ff',   // primary-fixed 淡蓝
        c5: '#7c6cef',   // 紫色辅助
    }

    const blur = Math.max(6, size * 0.15)
    const s = (r: number) => size * r

    return (
        <div
            className={`animated-orb relative overflow-hidden rounded-full ${className ?? ''}`}
            style={{
                width: size,
                height: size,
                backgroundColor: colors.bg,
                animation: 'orb-hue-rotate 8s linear infinite',
                boxShadow: 'rgba(17,12,46,0.15) 0 48px 100px 0',
            }}
            aria-hidden="true"
        >
            <div
                className="absolute inset-0 flex items-center justify-center"
                style={{ '--orb-blur': `${blur}px`, animation: 'orb-hue-rotate-blur 6s linear infinite reverse' } as React.CSSProperties}
            >
                {[
                    { cls: 'orb-circle-1', sz: s(0.45), color: colors.c1, op: 0.9 },
                    { cls: 'orb-circle-2', sz: s(0.35), color: colors.c2, op: 0.85 },
                    { cls: 'orb-circle-3', sz: s(0.50), color: colors.c3, op: 0.9 },
                    { cls: 'orb-circle-4', sz: s(0.25), color: colors.c4, op: 0.8 },
                    { cls: 'orb-circle-5', sz: s(0.30), color: colors.c5, op: 0.85 },
                ].map((c) => (
                    <div
                        key={c.cls}
                        className={`${c.cls} absolute rounded-full`}
                        style={{ width: c.sz, height: c.sz, opacity: c.op, backgroundColor: c.color }}
                    />
                ))}
            </div>
            <div
                className="absolute inset-0 rounded-full pointer-events-none"
                style={{ background: 'linear-gradient(to bottom, rgba(255,255,255,0.4) 0%, transparent 100%)' }}
            />
        </div>
    )
}
