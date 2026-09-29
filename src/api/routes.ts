export const WorkroomRoutes = {
  tasks: '/api/tasks',
  task: (id: string) => `/api/tasks/${id}`,
  events: (id: string) => `/api/tasks/${id}/events`,
  messages: (id: string) => `/api/tasks/${id}/messages`,
  document: (id: string) => `/api/tasks/${id}/document`,
  download: (id: string, format: string) =>
    `/api/tasks/${id}/download?format=${format}`
}
