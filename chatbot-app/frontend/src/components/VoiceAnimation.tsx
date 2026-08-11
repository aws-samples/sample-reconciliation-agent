"use client"

import React from 'react'

interface VoiceAnimationProps {
  type: 'listening' | 'speaking'
}

export function VoiceAnimation({ type }: VoiceAnimationProps) {
  if (type === 'listening') {
    // Pulse animation for listening
    return (
      <div className="flex items-center justify-center gap-1">
        <div className="w-1 h-1 bg-white rounded-full animate-pulse" />
        <div
          className="w-1 h-1 bg-white rounded-full animate-pulse"
          style={{ animationDelay: '0.2s' }}
        />
        <div
          className="w-1 h-1 bg-white rounded-full animate-pulse"
          style={{ animationDelay: '0.4s' }}
        />
      </div>
    )
  }

  // Wave animation for speaking (3 dots bouncing)
  return (
    <>
      <style>{`
        @keyframes voice-wave {
          0%, 60%, 100% {
            transform: translateY(0);
          }
          30% {
            transform: translateY(-4px);
          }
        }
      `}</style>
      <div className="flex items-center justify-center gap-0.5">
        <div
          className="w-1 h-1 bg-white rounded-full"
          style={{ animation: 'voice-wave 1.2s infinite ease-in-out' }}
        />
        <div
          className="w-1 h-1 bg-white rounded-full"
          style={{ animation: 'voice-wave 1.2s infinite ease-in-out', animationDelay: '0.2s' }}
        />
        <div
          className="w-1 h-1 bg-white rounded-full"
          style={{ animation: 'voice-wave 1.2s infinite ease-in-out', animationDelay: '0.4s' }}
        />
      </div>
    </>
  )
}
