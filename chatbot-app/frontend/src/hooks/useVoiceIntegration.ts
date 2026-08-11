/**
 * useVoiceIntegration - Voice chat integration for ChatInterface
 *
 * Wraps useVoiceChat and integrates with useChat state management
 */

import { useCallback, useMemo } from 'react'
import { useVoiceChat } from './useVoiceChat'
import { AgentStatus } from '@/types/events'

export interface UseVoiceIntegrationOptions {
  sessionId: string | null
  enabledToolIds: string[]
  agentStatus: string
  addVoiceToolExecution: (toolExec: any) => void
  updateVoiceMessage: (role: 'user' | 'assistant', text: string, isFinal: boolean) => void
  setVoiceStatus: (status: AgentStatus) => void
  finalizeVoiceMessage: () => void
  onSessionCreated?: () => void
}

export function useVoiceIntegration({
  sessionId,
  enabledToolIds,
  agentStatus,
  addVoiceToolExecution,
  updateVoiceMessage,
  setVoiceStatus,
  finalizeVoiceMessage,
  onSessionCreated,
}: UseVoiceIntegrationOptions) {

  // Voice chat hook - delegates state management to useChat via callbacks
  const {
    isSupported: isVoiceSupported,
    currentToolExecution: voiceToolExecution,
    error: voiceError,
    connect: connectVoiceInternal,
    disconnect: disconnectVoiceInternal,
  } = useVoiceChat({
    sessionId,
    enabledTools: enabledToolIds,
    onStatusChange: setVoiceStatus,
    onTranscript: (entry) => {
      if (entry.role && entry.text) {
        updateVoiceMessage(entry.role, entry.text, entry.isFinal)
      }
    },
    onToolExecution: (tool) => {
      // Create a tool execution object that matches useChat expectations
      const toolExec = {
        id: tool.toolUseId,
        toolName: tool.toolName,
        toolInput: tool.input,
        toolResult: tool.result,
        isComplete: tool.status !== 'running',
        isError: tool.status === 'error',
        reasoning: [], // Voice mode doesn't have reasoning
      }
      console.log('[VoiceIntegration] Created toolExec for addVoiceToolExecution:', toolExec)
      addVoiceToolExecution(toolExec)
    },
    onResponseComplete: () => {
      console.log('[VoiceIntegration] Response complete, finalizing voice message')
      finalizeVoiceMessage()
    },
    onError: (error) => {
      console.error('[VoiceIntegration] Error:', error)
    },
    onSessionCreated: onSessionCreated,
  })

  // Helper to check if voice mode is active (derived from unified agentStatus)
  const isVoiceActive = useMemo(() => {
    return agentStatus.startsWith('voice_')
  }, [agentStatus])

  // Connect voice (only if not already active)
  const connectVoice = useCallback(async () => {
    if (!isVoiceActive) {
      await connectVoiceInternal()
    }
  }, [isVoiceActive, connectVoiceInternal])

  // Disconnect voice (only if active)
  const disconnectVoice = useCallback(() => {
    if (isVoiceActive) {
      disconnectVoiceInternal()
    }
  }, [isVoiceActive, disconnectVoiceInternal])

  // Force disconnect (always disconnect, regardless of state)
  const forceDisconnectVoice = useCallback(() => {
    disconnectVoiceInternal()
  }, [disconnectVoiceInternal])

  return {
    // Voice state
    isVoiceSupported,
    isVoiceActive,
    voiceToolExecution,
    voiceError,

    // Voice controls
    connectVoice,
    disconnectVoice,
    forceDisconnectVoice,
  }
}
