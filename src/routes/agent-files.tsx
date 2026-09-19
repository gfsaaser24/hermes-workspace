import { Suspense, lazy } from 'react'
import { createFileRoute } from '@tanstack/react-router'

const AgentFilesScreen = lazy(async () => {
  const module = await import('@/screens/agent-files/agent-files-screen')
  return { default: module.AgentFilesScreen }
})

export const Route = createFileRoute('/agent-files')({
  ssr: false,
  component: function AgentFilesRoute() {
    return (
      <Suspense fallback={<div className="p-4 text-sm text-primary-600">Loading Agent Files…</div>}>
        <AgentFilesScreen />
      </Suspense>
    )
  },
})
