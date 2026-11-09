import axios from 'axios';
import { apiUrl } from '../../app/api';
const api = axios.create({ baseURL: apiUrl('/api/management'), timeout: 10000, withCredentials: true });
api.interceptors.response.use(response => response, error => {
  if (error.response?.status === 401) window.dispatchEvent(new Event('auth:logout'));
  return Promise.reject(error);
});
export const employeeAPI = {
  getAll: () => api.get('/employees'),
  getOptions: () => api.get('/employees/options'),
  getById: (id) => api.get(`/employees/${id}`),
  create: (data) => api.post('/employees', data),
  update: (id, data) => api.put(`/employees/${id}`, data),
  delete: (id) => api.delete(`/employees/${id}`)
};

// 项目 API
export const projectAPI = {
  getAll: () => api.get('/projects'),
  getById: (id) => api.get(`/projects/${id}`),
  create: (data) => api.post('/projects', data),
  update: (id, data) => api.put(`/projects/${id}`, data),
  delete: (id) => api.delete(`/projects/${id}`)
};

// 客户 API
export const customerAPI = {
  getAll: () => api.get('/customers'),
  getById: (id) => api.get(`/customers/${id}`),
  getIpProfile: (id) => api.get(`/customers/${id}/ip-profile`),
  saveIpProfile: (id, payload) => api.put(`/customers/${id}/ip-profile`, payload),
  createFromIpIntake: (payload) => api.post('/customers/intake', payload),
  create: (data) => api.post('/customers', data),
  update: (id, data) => api.put(`/customers/${id}`, data),
  delete: (id) => api.delete(`/customers/${id}`)
};

// 任务 API
export const taskAPI = {
  getAll: (params) => api.get('/tasks', { params }),
  getById: (id) => api.get(`/tasks/${id}`),
  create: (data) => api.post('/tasks', data),
  createBatch: (tasks) => api.post('/tasks/batch', { tasks }),
  update: (id, data) => api.put(`/tasks/${id}`, data),
  delete: (id) => api.delete(`/tasks/${id}`),
  getTodayGrouped: () => api.get('/tasks/today/grouped')
};

// AI API
export const aiAPI = {
  extractDocument: (file) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post('/ai/extract-document', formData, {
      timeout: 60000,
      headers: { 'Content-Type': undefined }
    });
  },
  organizeIpProfile: (data) => api.post('/ai/organize-ip-profile', data, { timeout: 60000 }),
  analyzeTask: (taskId) => api.post(`/ai/analyze-task/${taskId}`),
  analyzeToday: () => api.post('/ai/analyze-today'),
  getReminder: (employeeId) => api.get(`/ai/reminder/${employeeId}`)
};

export default api;
