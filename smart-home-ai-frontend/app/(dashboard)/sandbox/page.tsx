'use client'

import SandboxClient from './SandboxClient'
import { Suspense } from 'react'

export default function SandboxPage() {
  return <Suspense fallback={null}><SandboxClient /></Suspense>
}
