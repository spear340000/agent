export const WorkroomRoutes = {
  tasks: '/api/tasks',
  task: (id: string) => `/api/tasks/${id}`,
  events: (id: string) => `/api/tasks/${id}/events`,
  messages: (id: string) => `/api/tasks/${id}/messages`,
  document: (id: string) => `/api/tasks/${id}/document`,
  download: (id: string, format: string) =>
    `/api/tasks/${id}/download?format=${format}`
}

export const APIRoutes = {
  GetAgents: (agentOSUrl: string) => `${agentOSUrl}/agents`,
  AgentRun: (agentOSUrl: string) => `${agentOSUrl}/agents/{agent_id}/runs`,
  Status: (agentOSUrl: string) => `${agentOSUrl}/health`,
  GetSessions: (agentOSUrl: string) => `${agentOSUrl}/sessions`,
  GetSession: (agentOSUrl: string, sessionId: string) =>
    `${agentOSUrl}/sessions/${sessionId}/runs`,
  DeleteSession: (agentOSUrl: string, sessionId: string) =>
    `${agentOSUrl}/sessions/${sessionId}`,
  GetTeams: (agentOSUrl: string) => `${agentOSUrl}/teams`,
  TeamRun: (agentOSUrl: string, teamId: string) =>
    `${agentOSUrl}/teams/${teamId}/runs`,
  DeleteTeamSession: (agentOSUrl: string, teamId: string, sessionId: string) =>
    `${agentOSUrl}/v1/teams/${teamId}/sessions/${sessionId}`
}
