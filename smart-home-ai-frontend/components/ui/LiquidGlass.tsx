/**
 * LiquidGlass Wrapper Component
 * Core component — every interactive surface uses this system.
 * From PART 2 of frontend-skill.
 */
import React from 'react'

interface LiquidGlassProps {
  children: React.ReactNode
  variant?: '' | 'cobalt' | 'primary' | 'olive'
  pill?: boolean
  card?: boolean
  blur?: 'minimal' | 'standard' | 'heavy'
  className?: string
  style?: React.CSSProperties
  onClick?: () => void
}

export function LiquidGlass({
  children,
  variant = '',
  pill = false,
  card = false,
  blur = 'minimal',
  className = '',
  style,
  onClick,
}: LiquidGlassProps) {
  return (
    <div
      className={`liquid-glass-wrapper ${pill ? 'liquid-glass-pill' : ''} ${card ? 'liquid-glass-card' : ''} ${variant ? `liquid-glass-${variant}` : ''} liquid-glass-blur-${blur} ${className}`}
      style={style}
      onClick={onClick}
    >
      <div className="liquid-glass-visual-layers">
        <div className="liquid-glass-effect"></div>
        <div className="liquid-glass-tint"></div>
        <div className="liquid-glass-shine"></div>
      </div>
      <div className="liquid-glass-content">{children}</div>
    </div>
  )
}
