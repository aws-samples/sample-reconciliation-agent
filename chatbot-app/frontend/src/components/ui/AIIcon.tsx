'use client'

import Lottie from 'lottie-react'
import aiLoadingAnimation from '../../../public/animations/ai-loading.json'

interface AIIconProps {
  size?: number
  isAnimating?: boolean
  className?: string
}

export const AIIcon = ({ size = 36, isAnimating = false, className = '' }: AIIconProps) => {
  return (
    <div
      className={`flex items-center justify-center flex-shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      <Lottie
        animationData={aiLoadingAnimation}
        loop={isAnimating}
        autoplay={isAnimating}
        initialSegment={isAnimating ? undefined : [0, 1]}
        style={{ width: size, height: size }}
      />
    </div>
  )
}
