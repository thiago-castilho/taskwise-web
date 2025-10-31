'use strict';

const express = require('express');
const path = require('path');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const ejsLayouts = require('express-ejs-layouts');

const { apiClient } = require('./lib/apiClient');
const { ensureAuth, injectUser, ensureAdmin } = require('./middleware/auth');

const app = express();

// Configurações
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('layout', 'layout');
app.use(ejsLayouts);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(
  session({
    secret: 'taskwise-web-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true }
  })
);

app.use('/public', express.static(path.join(__dirname, 'public')));

// Middleware para expor sessão/usuário às views
app.use(injectUser);

// Helpers para flash simples via sessão
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || [];
  req.session.flash = [];
  res.flash = (type, message) => {
    req.session.flash.push({ type, message });
  };
  next();
});

// Timezone: captura via query (?tz=...) e expõe às views; endpoint para set via JS
app.use((req, res, next) => {
  if (req.query && req.query.tz) {
    req.session.tz = String(req.query.tz);
  }
  res.locals.tz = req.session.tz || null;
  next();
});

app.post('/tz', (req, res) => {
  const tz = req.body?.tz;
  if (tz) req.session.tz = String(tz);
  res.json({ ok: true, tz: req.session.tz || null });
});

// Rotas públicas
app.get('/login', (req, res) => {
  if (req.session.token) return res.redirect('/dashboard');
  res.render('login', { title: 'Login - TaskWise' });
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const api = apiClient(undefined, req.session.tz);
    const resp = await api.post('/auth/login', { email, password });
    const { token, user } = resp.data;
    req.session.token = token;
    req.session.user = user;
    return res.redirect('/dashboard');
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.[0]?.message || err.response?.data?.message || err.message;
    res.flash('danger', `Login falhou (${status || 'erro'}): ${msg}`);
    return res.redirect('/login');
  }
});

// Cadastro público (signup)
app.get('/signup', (req, res) => {
  if (req.session.token) return res.redirect('/dashboard');
  res.render('users/new', { title: 'Criar conta - TaskWise', actionPath: '/signup' });
});

app.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const api = apiClient(undefined, req.session.tz); // público, sem token
    await api.post('/users', { name, email, password });
    res.flash('success', 'Conta criada com sucesso. Faça login.');
    return res.redirect('/login');
  } catch (err) {
    const status = err.response?.status;
    const msg = status === 422 ? 'Validação de usuário falhou.' : (err.response?.data?.[0]?.message || err.response?.data?.message || err.message);
    res.flash('danger', `Falha ao criar conta (${status || 'erro'}): ${msg}`);
    return res.redirect('/signup');
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// Rotas autenticadas
app.get('/', (req, res) => res.redirect('/dashboard'));

app.get('/dashboard', ensureAuth, async (req, res) => {
  try {
    const api = apiClient(req.session.token, req.session.tz);
    // Buscar lista de sprints
    const sprints = (await api.get('/sprints')).data.items || [];
    const fromQuery = req.query.sprintId ? sprints.find(s => s.id === req.query.sprintId) : null;
    const selected = fromQuery || sprints.find((s) => s.status === 'Started') || sprints[0];
    let selectedSprint = null;
    let summary = null;
    
    if (selected) {
      // SEMPRE buscar detalhes completos e atualizados da sprint diretamente por ID
      // Isso garante que temos a dueDate correta após iniciar sprint ou alterar capacidade
      try {
        selectedSprint = (await api.get(`/sprints/${selected.id}`)).data;
      } catch (e) {
        // Se falhar, usar o objeto da lista como fallback
        selectedSprint = selected;
      }
      
      // Buscar summary do dashboard que também pode ter dados atualizados
      try {
        summary = (await api.get('/dashboard/summary', { params: { sprintId: selected.id } })).data;
      } catch (e) {
        // Se falhar, summary fica null
        summary = null;
      }
    }
    res.render('dashboard', {
      title: 'Dashboard - TaskWise',
      sprints,
      selectedSprint: selectedSprint || null,
      summary
    });
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.[0]?.message || err.response?.data?.message || err.message;
    res.flash('danger', `Falha ao carregar dashboard (${status || 'erro'}): ${msg}`);
    res.render('dashboard', { title: 'Dashboard - TaskWise', sprints: [], selectedSprint: null, summary: null });
  }
});

// Listagem de tarefas com filtros e paginação
app.get('/tasks', ensureAuth, async (req, res) => {
  const api = apiClient(req.session.token, req.session.tz);
  const params = {
    status: req.query.status || undefined,
    sprintId: req.query.sprintId || undefined,
    risco: req.query.risco || undefined,
    complexidade: req.query.complexidade || undefined,
    assigneeId: req.query.assigneeId || undefined,
    page: req.query.page ? Number(req.query.page) : 1,
    pageSize: req.query.pageSize ? Number(req.query.pageSize) : 10
  };
  try {
    const data = (await api.get('/tasks', { params })).data;
    // Enriquecer itens que não vieram completos (ex.: totalHours/totalDays/dueDate)
    if (Array.isArray(data.items) && data.items.length) {
      const needDetails = data.items.filter(t => t.totalHours == null || t.totalDays == null || !t.dueDate);
      if (needDetails.length) {
        const details = await Promise.all(needDetails.map(t => api.get(`/tasks/${t.id}`).then(r => r.data).catch(() => null)));
        const mapById = new Map(details.filter(Boolean).map(d => [d.id, d]));
        data.items = data.items.map(t => mapById.has(t.id) ? mapById.get(t.id) : t);
      }
    }
    const sprints = (await api.get('/sprints')).data.items || [];
    // Buscar usuários disponíveis para seleção de responsáveis (qualquer usuário autenticado)
    let users = [];
    try {
      users = (await api.get('/users/available')).data.items || [];
    } catch (e) {
      users = [];
    }
    const riskOptions = ['Baixo', 'Médio', 'Alto'];
    const complexityOptions = ['Baixa', 'Média', 'Alta'];
    res.render('tasks/list', { title: 'Tarefas - TaskWise', data, sprints, users, filters: params, riskOptions, complexityOptions });
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.[0]?.message || err.response?.data?.message || err.message;
    res.flash('danger', `Falha ao carregar tarefas (${status || 'erro'}): ${msg}`);
    const riskOptions = ['Baixo', 'Médio', 'Alto'];
    const complexityOptions = ['Baixa', 'Média', 'Alta'];
    res.render('tasks/list', { title: 'Tarefas - TaskWise', data: { items: [], page: 1, pageSize: 10, total: 0, totalPages: 0 }, sprints: [], users: [], filters: params, riskOptions, complexityOptions });
  }
});

// Nova tarefa
app.get('/tasks/new', ensureAuth, async (req, res) => {
  try {
    const api = apiClient(req.session.token, req.session.tz);
    const sprints = (await api.get('/sprints')).data.items || [];
    // Dropdowns de Risco/Complexidade (valores determinados)
    const riskOptions = ['Baixo', 'Médio', 'Alto'];
    const complexityOptions = ['Baixa', 'Média', 'Alta'];
    // Usuários disponíveis para seleção de responsáveis (qualquer usuário autenticado)
    let users = [];
    try { 
      users = (await api.get('/users/available')).data.items || [];
    } catch (e) {
      // Fallback se endpoint não existir
      if (e.response?.status === 404 && req.session.user?.role === 'Admin') {
        try {
          const adminUsers = (await api.get('/users')).data.items || [];
          users = adminUsers.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role }));
        } catch (fallbackErr) {
          users = [];
        }
      } else {
        users = [];
      }
    }
    res.render('tasks/form', { title: 'Nova Tarefa - TaskWise', task: null, sprints, users, riskOptions, complexityOptions });
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.[0]?.message || err.response?.data?.message || err.message;
    res.flash('danger', `Falha ao carregar formulário (${status || 'erro'}): ${msg}`);
    res.redirect('/tasks');
  }
});

app.post('/tasks', ensureAuth, async (req, res) => {
  // Validação client-side mínima O<=M<=P por fase
  function validPhase(p) {
    if (!p) return false;
    const O = parseFloat(p.O), M = parseFloat(p.M), P = parseFloat(p.P);
    return !Number.isNaN(O) && !Number.isNaN(M) && !Number.isNaN(P) && O <= M && M <= P;
  }

  try {
    const body = req.body;
    const phases = {
      analiseModelagem: { O: body.am_O, M: body.am_M, P: body.am_P },
      execucao: { O: body.ex_O, M: body.ex_M, P: body.ex_P },
      reteste: { O: body.re_O, M: body.re_M, P: body.re_P },
      documentacao: { O: body.do_O, M: body.do_M, P: body.do_P }
    };
    if (![phases.analiseModelagem, phases.execucao, phases.reteste, phases.documentacao].every(validPhase)) {
      res.flash('warning', 'Validação PERT falhou: garanta O ≤ M ≤ P em todas as fases.');
      return res.redirect('/tasks/new');
    }
    const payload = {
      title: body.title,
      description: body.description || undefined,
      risco: body.risco || undefined,
      complexidade: body.complexidade || undefined,
      sprintId: body.sprintId || undefined,
      phases
    };
    const api = apiClient(req.session.token, req.session.tz);
    await api.post('/tasks', payload);
    res.flash('success', 'Tarefa criada com sucesso');
    res.redirect('/tasks');
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.[0]?.message || err.response?.data?.message || err.message;
    res.flash('danger', `Falha ao criar tarefa (${status || 'erro'}): ${msg}`);
    res.redirect('/tasks/new');
  }
});

// Detalhe/edição tarefa
app.get('/tasks/:id', ensureAuth, async (req, res) => {
  try {
    const api = apiClient(req.session.token, req.session.tz);
    const task = (await api.get(`/tasks/${req.params.id}`)).data;
    const sprints = (await api.get('/sprints')).data.items || [];
    const riskOptions = ['Baixo', 'Médio', 'Alto'];
    const complexityOptions = ['Baixa', 'Média', 'Alta'];
    // Usuários disponíveis para seleção de responsáveis (qualquer usuário autenticado)
    let users = [];
    try { 
      users = (await api.get('/users/available')).data.items || [];
    } catch (e) { 
      // Fallback temporário se endpoint não existir
      if (e.response?.status === 404 && req.session.user?.role === 'Admin') {
        try {
          const adminUsers = (await api.get('/users')).data.items || [];
          users = adminUsers.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role }));
        } catch (fallbackErr) {
          users = [];
        }
      } else {
        users = [];
      }
    }
    res.render('tasks/form', { title: `Tarefa ${task.title} - TaskWise`, task, sprints, users, riskOptions, complexityOptions });
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.[0]?.message || err.response?.data?.message || err.message;
    res.flash('danger', `Falha ao carregar a tarefa (${status || 'erro'}): ${msg}`);
    res.redirect('/tasks');
  }
});

app.post('/tasks/:id', ensureAuth, async (req, res) => {
  function validPhase(p) {
    if (!p) return false;
    const O = parseFloat(p.O), M = parseFloat(p.M), P = parseFloat(p.P);
    return !Number.isNaN(O) && !Number.isNaN(M) && !Number.isNaN(P) && O <= M && M <= P;
  }
  try {
    const body = req.body;
    const phases = {
      analiseModelagem: { O: body.am_O, M: body.am_M, P: body.am_P },
      execucao: { O: body.ex_O, M: body.ex_M, P: body.ex_P },
      reteste: { O: body.re_O, M: body.re_M, P: body.re_P },
      documentacao: { O: body.do_O, M: body.do_M, P: body.do_P }
    };
    if (![phases.analiseModelagem, phases.execucao, phases.reteste, phases.documentacao].every(validPhase)) {
      res.flash('warning', 'Validação PERT falhou: garanta O ≤ M ≤ P em todas as fases.');
      return res.redirect(`/tasks/${req.params.id}`);
    }
    const payload = {
      title: body.title,
      description: body.description || undefined,
      risco: body.risco || undefined,
      complexidade: body.complexidade || undefined,
      sprintId: body.sprintId || undefined,
      phases
    };
    const api = apiClient(req.session.token, req.session.tz);
    await api.put(`/tasks/${req.params.id}`, payload);
    res.flash('success', 'Tarefa atualizada');
    res.redirect(`/tasks/${req.params.id}`);
  } catch (err) {
    const status = err.response?.status;
    const msg = status === 422 ? 'Validação PERT ou dados inválidos.' : (status === 409 ? 'Tarefa já vinculada a outra sprint.' : (err.response?.data?.[0]?.message || err.response?.data?.message || err.message));
    res.flash('danger', `Falha ao atualizar tarefa (${status || 'erro'}): ${msg}`);
    res.redirect(`/tasks/${req.params.id}`);
  }
});

// Excluir tarefa (Admin)
app.post('/tasks/:id/delete', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const api = apiClient(req.session.token, req.session.tz);
    await api.delete(`/tasks/${req.params.id}`);
    res.flash('success', 'Tarefa excluída com sucesso');
    res.redirect('/tasks');
  } catch (err) {
    const status = err.response?.status;
    const msg = status === 404 ? 'Tarefa não encontrada.' : (status === 403 ? 'Ação restrita a Admin.' : (err.response?.data?.[0]?.message || err.response?.data?.message || err.message));
    res.flash('danger', `Falha ao excluir tarefa (${status || 'erro'}): ${msg}`);
    res.redirect(`/tasks/${req.params.id}`);
  }
});

// Alterar status com bloqueio/desbloqueio
app.post('/tasks/:id/status', ensureAuth, async (req, res) => {
  try {
    const api = apiClient(req.session.token, req.session.tz);
    const desired = req.body.status;
    const currentTask = (await api.get(`/tasks/${req.params.id}`)).data;
    const current = currentTask.status;
    const isBlocking = desired === 'Bloqueada' && req.body.motivo && req.body.responsavelId;
    // Se não houve mudança de status e não há dados de bloqueio, não chama API
    if (desired === current && !isBlocking) {
      res.flash('info', 'Nenhuma alteração de status para aplicar.');
      return res.redirect(`/tasks/${req.params.id}`);
    }
    const payload = { status: desired };
    if (desired === 'Bloqueada') {
      payload.block = { motivo: req.body.motivo, responsavelId: req.body.responsavelId };
    }
    await api.patch(`/tasks/${req.params.id}/status`, payload);
    res.flash('success', 'Status atualizado');
    res.redirect(`/tasks/${req.params.id}`);
  } catch (err) {
    const status = err.response?.status;
    const msg = status === 422 ? 'Transição inválida (ex.: tarefa sem sprint não pode avançar).' : (status === 409 ? 'Concluir sem responsável ou sprint não iniciada.' : (err.response?.data?.[0]?.message || err.response?.data?.message || err.message));
    res.flash('danger', `Falha ao alterar status (${status || 'erro'}): ${msg}`);
    res.redirect(`/tasks/${req.params.id}`);
  }
});

// Definir responsável
app.post('/tasks/:id/assign', ensureAuth, async (req, res) => {
  try {
    const api = apiClient(req.session.token, req.session.tz);
    const userId = req.body.assigneeId;
    await api.patch(`/tasks/${req.params.id}/assign/${userId}`);
    res.flash('success', 'Responsável atualizado');
    res.redirect(`/tasks/${req.params.id}`);
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.[0]?.message || err.response?.data?.message || err.message;
    res.flash('danger', `Falha ao definir responsável (${status || 'erro'}): ${msg}`);
    res.redirect(`/tasks/${req.params.id}`);
  }
});

// Sprints
app.get('/sprints', ensureAuth, async (req, res) => {
  try {
    const api = apiClient(req.session.token, req.session.tz);
    const sprints = (await api.get('/sprints')).data.items || [];
    const tasksAll = (await api.get('/tasks', { params: { page: 1, pageSize: 1000 } })).data.items || [];
    const tasksWithoutSprint = tasksAll.filter(t => !t.sprintId);
    // Mapa de pendências por sprint: existe tarefa status != 'Concluída'
    const pendingBySprint = {};
    for (const t of tasksAll) {
      if (t.sprintId && t.status !== 'Concluída') pendingBySprint[t.sprintId] = true;
    }
    res.render('sprints/list', { title: 'Sprints - TaskWise', sprints, tasks: tasksWithoutSprint, pendingBySprint });
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.[0]?.message || err.response?.data?.message || err.message;
    res.flash('danger', `Falha ao carregar sprints (${status || 'erro'}): ${msg}`);
    res.render('sprints/list', { title: 'Sprints - TaskWise', sprints: [], tasks: [], pendingBySprint: {} });
  }
});

// Detalhe/edição de sprint com visualização das tarefas que a compõem
app.get('/sprints/:id', ensureAuth, async (req, res) => {
  try {
    const api = apiClient(req.session.tz ? req.session.token : req.session.token, req.session.tz);
    const sprint = (await api.get(`/sprints/${req.params.id}`)).data;
    // Tarefas da sprint
    let tasksInSprint = (await api.get('/tasks', { params: { sprintId: sprint.id, page: 1, pageSize: 1000 } })).data.items || [];
    // Enriquecimento se necessário
    if (tasksInSprint.length) {
      const needDetails = tasksInSprint.filter(t => t.totalHours == null || t.totalDays == null || !t.dueDate);
      if (needDetails.length) {
        const details = await Promise.all(needDetails.map(t => api.get(`/tasks/${t.id}`).then(r => r.data).catch(() => null)));
        const mapById = new Map(details.filter(Boolean).map(d => [d.id, d]));
        tasksInSprint = tasksInSprint.map(t => mapById.has(t.id) ? mapById.get(t.id) : t);
      }
    }
    // Tarefas disponíveis para adicionar (sem sprint)
    const tasksWithoutSprint = (await api.get('/tasks', { params: { page: 1, pageSize: 1000 } })).data.items.filter(t => !t.sprintId) || [];
    const hasPending = tasksInSprint.some(t => t.status !== 'Concluída');
    res.render('sprints/detail', { title: `Sprint ${sprint.name} - TaskWise`, sprint, tasksInSprint, tasksWithoutSprint, hasPending });
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.[0]?.message || err.response?.data?.message || err.message;
    res.flash('danger', `Falha ao carregar sprint (${status || 'erro'}): ${msg}`);
    res.redirect('/sprints');
  }
});

app.post('/sprints', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const api = apiClient(req.session.token, req.session.tz);
    const payload = {
      name: req.body.name,
      taskIds: Array.isArray(req.body.taskIds) ? req.body.taskIds : (req.body.taskIds ? [req.body.taskIds] : []),
      capacity: req.body.junior || req.body.pleno || req.body.senior ? {
        junior: req.body.junior ? Number(req.body.junior) : undefined,
        pleno: req.body.pleno ? Number(req.body.pleno) : undefined,
        senior: req.body.senior ? Number(req.body.senior) : undefined
      } : undefined
    };
    await api.post('/sprints', payload);
    res.flash('success', 'Sprint criada');
    res.redirect('/sprints');
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.[0]?.message || err.response?.data?.message || err.message;
    res.flash('danger', `Falha ao criar sprint (${status || 'erro'}): ${msg}`);
    res.redirect('/sprints');
  }
});

app.post('/sprints/:id/start', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const api = apiClient(req.session.token, req.session.tz);
    await api.patch(`/sprints/${req.params.id}/start`);
    res.flash('success', 'Sprint iniciada');
    res.redirect('/sprints');
  } catch (err) {
    const status = err.response?.status;
    const msg = status === 422 ? 'Sem tarefas para iniciar.' : (err.response?.data?.[0]?.message || err.response?.data?.message || err.message);
    res.flash('danger', `Falha ao iniciar sprint (${status || 'erro'}): ${msg}`);
    res.redirect('/sprints');
  }
});

app.post('/sprints/:id/close', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const api = apiClient(req.session.token, req.session.tz);
    await api.patch(`/sprints/${req.params.id}/close`);
    res.flash('success', 'Sprint encerrada');
    res.redirect('/sprints');
  } catch (err) {
    const status = err.response?.status;
    const msg = status === 409 ? 'Existem tarefas não concluídas na sprint.' : (err.response?.data?.[0]?.message || err.response?.data?.message || err.message);
    res.flash('danger', `Falha ao encerrar sprint (${status || 'erro'}): ${msg}`);
    res.redirect('/sprints');
  }
});

// Adicionar tarefas a uma sprint (somente Created)
app.post('/sprints/:id/tasks', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const api = apiClient(req.session.token, req.session.tz);
    const taskIds = Array.isArray(req.body.taskIds) ? req.body.taskIds : (req.body.taskIds ? [req.body.taskIds] : []);
    await api.patch(`/sprints/${req.params.id}/tasks`, { taskIds });
    res.flash('success', 'Tarefas adicionadas à sprint');
    res.redirect(`/sprints/${req.params.id}`);
  } catch (err) {
    const status = err.response?.status;
    const msg = status === 409
      ? 'Sprint não editável ou tarefa já vinculada a outra sprint.'
      : (status === 422 ? 'Selecione pelo menos 1 tarefa.' : (err.response?.data?.[0]?.message || err.response?.data?.message || err.message));
    res.flash('danger', `Falha ao adicionar tarefas (${status || 'erro'}): ${msg}`);
    res.redirect(`/sprints/${req.params.id}`);
  }
});

// Remover tarefas de uma sprint (somente Created)
app.post('/sprints/:id/tasks/remove', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const api = apiClient(req.session.token, req.session.tz);
    const taskIds = Array.isArray(req.body.taskIds) ? req.body.taskIds : (req.body.taskIds ? [req.body.taskIds] : []);
    await api.patch(`/sprints/${req.params.id}/tasks/remove`, { taskIds });
    res.flash('success', 'Tarefas removidas da sprint');
    res.redirect(`/sprints/${req.params.id}`);
  } catch (err) {
    const status = err.response?.status;
    const msg = status === 409
      ? 'Sprint não editável (já iniciada/encerrada).'
      : (status === 422 ? 'Seleção inválida: informe taskIds pertencentes à sprint.' : (err.response?.data?.[0]?.message || err.response?.data?.message || err.message));
    res.flash('danger', `Falha ao remover tarefas (${status || 'erro'}): ${msg}`);
    res.redirect(`/sprints/${req.params.id}`);
  }
});

app.post('/sprints/:id/capacity', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const api = apiClient(req.session.token, req.session.tz);
    const payload = {
      junior: req.body.junior ? Number(req.body.junior) : undefined,
      pleno: req.body.pleno ? Number(req.body.pleno) : undefined,
      senior: req.body.senior ? Number(req.body.senior) : undefined
    };
    await api.patch(`/sprints/${req.params.id}/capacity`, payload);
    res.flash('success', 'Capacidade atualizada');
    res.redirect(`/sprints/${req.params.id}`);
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.[0]?.message || err.response?.data?.message || err.message;
    res.flash('danger', `Falha ao definir capacidade (${status || 'erro'}): ${msg}`);
    res.redirect(`/sprints/${req.params.id}`);
  }
});

// Usuários
app.get('/users/me', (req, res, next) => {
  // Middleware customizado para não redirecionar requisições JSON
  if (!req.session?.token) {
    return res.status(401).json({ error: 'Não autenticado. Faça login novamente.' });
  }
  next();
}, async (req, res) => {
  try {
    const api = apiClient(req.session.token, req.session.tz);
    const response = await api.get('/users/me');
    
    if (!response || !response.data) {
      return res.status(500).json({ error: 'Resposta inválida da API' });
    }
    
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    let msg = 'Erro desconhecido';
    
    if (err.response?.status === 404) {
      msg = 'Endpoint não encontrado na API. Verifique se a API está rodando em http://localhost:3000';
    } else if (err.response?.status === 401) {
      msg = 'Token inválido ou expirado. Faça login novamente.';
    } else if (err.code === 'ECONNREFUSED') {
      msg = 'Não foi possível conectar à API. Verifique se está rodando em http://localhost:3000';
    } else if (err.response?.data) {
      if (Array.isArray(err.response.data)) {
        msg = err.response.data[0]?.message || err.response.data[0]?.code || 'Erro na API';
      } else {
        msg = err.response.data.message || err.response.data.error || 'Erro na API';
      }
    } else if (err.message) {
      msg = err.message;
    }
    
    res.status(status).json({ error: msg });
  }
});

app.get('/users', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const api = apiClient(req.session.token, req.session.tz);
    const users = (await api.get('/users')).data.items || [];
    res.render('users/list', { title: 'Usuários - TaskWise', users });
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.[0]?.message || err.response?.data?.message || err.message;
    res.flash('danger', `Falha ao carregar usuários (${status || 'erro'}): ${msg}`);
    res.render('users/list', { title: 'Usuários - TaskWise', users: [] });
  }
});

// Cadastro de usuário
app.get('/users/new', ensureAuth, ensureAdmin, (req, res) => {
  res.render('users/new', { title: 'Novo Usuário - TaskWise', actionPath: '/users' });
});

app.post('/users', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const api = apiClient(req.session.token, req.session.tz);
    await api.post('/users', { name: req.body.name, email: req.body.email, password: req.body.password });
    res.flash('success', 'Usuário criado com sucesso');
    res.redirect('/users');
  } catch (err) {
    const status = err.response?.status;
    const msg = status === 422 ? 'Validação de usuário falhou.' : (err.response?.data?.[0]?.message || err.response?.data?.message || err.message);
    res.flash('danger', `Falha ao criar usuário (${status || 'erro'}): ${msg}`);
    res.redirect('/users/new');
  }
});

// Porta
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`TaskWise Web ouvindo em http://localhost:${PORT}`);
});

module.exports = app;


