/**
 * CobaltBtn — Glass button with spring hover + press feedback
 * From PART 2 of frontend-skill (React Components section)
 * Uses: scale(1.03) hover, scale(0.96) press, spring cubic-bezier(0.34,1.56,0.64,1)
 */
'use client'
import React, { useState } from 'react'
import { LiquidGlass } from './LiquidGlass'

interface CobaltBtnProps {
  label: string
  type?: 'button' | 'submit'
  disabled?: boolean
  style?: React.CSSProperties
  onClick?: () => void
}

export function CobaltBtn({ label, type = 'button', disabled = false, style: sx, onClick }: CobaltBtnProps) {
  const [hov, setHov] = useState(false)
  const [pressed, setPressed] = useState(false)
  const scale = disabled ? 1 : pressed ? 0.96 : hov ? 1.03 : 1

  return (
    <LiquidGlass
      variant="cobalt"
      pill
      blur="minimal"
      style={{
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'transform 0.38s cubic-bezier(0.34,1.56,0.64,1)',
        transform: `scale(${scale})`,
        opacity: disabled ? 0.6 : 1,
        ...sx,
      }}
      onClick={disabled ? undefined : onClick}
    >
      <button
        type={type}
        disabled={disabled}
        onMouseEnter={() => setHov(true)}
        onMouseLeave={() => { setHov(false); setPressed(false) }}
        onMouseDown={() => setPressed(true)}
        onMouseUp={() => setPressed(false)}
        style={{
          background: 'transparent',
          border: 'none',
          cursor: disabled ? 'not-allowed' : 'pointer',
          padding: '9px 20px',
          fontSize: 14,
          fontWeight: 500,
          color: '#fff',
          letterSpacing: '0.01em',
          whiteSpace: 'nowrap',
          fontFamily: 'inherit',
          width: '100%',
        }}
      >
        {label}
      </button>
    </LiquidGlass>
  )
}
